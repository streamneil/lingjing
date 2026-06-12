// 灵镜 对公充值闭环服务 — 订单 + 发票状态机 + 确认到账(钱路)。
//
// 决策来源:/plan-design-review(全闭环 + 套餐-only)+ /plan-eng-review(钱路加固)。
//   - 钱路并发:确认到账复用 claimNextJob(queue/index.ts)原子范式 —— db.transaction 内
//     条件 UPDATE WHERE status='paid_claimed',changes===1 才在**同事务** grant(双击/双超管
//     并发后来者 changes=0,不重发)。credit_ledger 的部分唯一索引 (order_id) WHERE kind='grant'
//     做双保险(即使守卫漏了,第二次 grant 也被 UNIQUE 拦)。
//   - 套餐全快照:下单把 name/price/credits/bonus/validity 全拷进 order 行;grant/发票只读快照,
//     与 pricing_plan 后续改/删无关。建单拒 price_yuan=NULL(面议)/ 未 enabled 套餐。
//   - order_no:建单事务内日计数 LJyyyymmdd-seq + UNIQUE 索引兜底。
//   - 状态迁移单一来源:transitionOrder / transitionInvoice 原子助手(WHERE status=from,
//     返 changes===1),所有状态变走这一门,防漂移(镜 pricing validatePlan 单一来源)。
//   - 账号隔离:list/get/下载经 scopeByActor —— 用户只看自己 created_by,超管看全机构。
//
// ┌─ 订单状态机 ─────────────────────────────────────────────────────────────┐
// │  pending_payment ─claimPaid(+回单)→ paid_claimed ─confirm→ credited(grant)│
// │                                          └─reject→ rejected ─resubmit→ paid_claimed
// │  pending/rejected ─cancel→ cancelled        credited 终态(退款走手工 runbook)│
// └──────────────────────────────────────────────────────────────────────────┘

import { randomUUID } from 'node:crypto';
import {
  db,
  scopeByActor,
  type RechargeOrderRow,
  type InvoiceRow,
  type OrderStatus,
  type InvoiceStatus,
  type PayeeSettingRow,
  type TenantInvoiceProfileRow,
} from '../db/index.js';
import { getPlan } from '../pricing/index.js';
import { grant } from '../credits/index.js';

const now = () => Date.now();

/** 业务校验错误(带 code,API 层透传 400/409)。 */
export class OrderError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// ── 订单号生成(事务内调用)──
// LJyyyymmdd-seq4;seq = 当日已有同前缀订单数 + 1。建单包在事务里 + UNIQUE 索引兜底,
// better-sqlite3 单写 + 同事务 → COUNT 与 INSERT 间无其他写,无竞态。
function genOrderNo(): string {
  const d = new Date(now());
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const prefix = `LJ${ymd}-`;
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM recharge_order WHERE order_no LIKE ?`)
    .get(`${prefix}%`) as { n: number };
  return `${prefix}${String(row.n + 1).padStart(4, '0')}`;
}

// ── 建单 ──
// 守卫(eng-review + 外部声音):
//   ① 套餐存在 + enabled + price_yuan 非 NULL(拒面议,PLAN_NOT_PRICED)。
//   ② payee 已配(外部 #7):平台没配对公收款账户 → 拒,不生成付不了的孤儿单。
//   ③ 复用未付单(外部 #1/#2):同 (tenant, user, plan) 已有 pending_payment 单 → 返现有
//      (不新建),杀掉「跳走/重选/双击」堆积的废弃单。镜 createLead 去重范式。
// 全快照落库,事务内出号 + 插入。
export const createOrder = db.transaction(
  (params: { tenantId: string; userId: string; planId: string }): RechargeOrderRow => {
    const plan = getPlan(params.planId);
    if (!plan || plan.enabled !== 1) throw new OrderError('PLAN_NOT_FOUND', '套餐不存在或已下架');
    if (plan.price_yuan == null)
      throw new OrderError('PLAN_NOT_PRICED', '面议套餐请联系商务,无法直接下单');

    // ② payee 未配 → 拒(否则用户拿到付不了的单)。
    const payee = getPayee();
    if (!payee.payee_name || !payee.bank_account)
      throw new OrderError('PAYEE_NOT_READY', '平台尚未开通对公收款,请联系运营');

    // ③ 复用同套餐的未付单(防孤儿堆积 + 双击重单)。
    const existing = db
      .prepare(
        `SELECT * FROM recharge_order
         WHERE tenant_id=? AND created_by=? AND plan_id=? AND status='pending_payment'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(params.tenantId, params.userId, plan.id) as RechargeOrderRow | undefined;
    if (existing) return existing;

    const id = randomUUID();
    const orderNo = genOrderNo();
    const t = now();
    db.prepare(
      `INSERT INTO recharge_order
         (id, tenant_id, created_by, order_no, plan_id, plan_name, price_yuan, credits, bonus_credits,
          validity_months, status, payment_method, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,'pending_payment','offline_bank',?,?)`,
    ).run(
      id,
      params.tenantId,
      params.userId,
      orderNo,
      plan.id,
      plan.name,
      plan.price_yuan,
      plan.credits,
      plan.bonus_credits,
      plan.validity_months,
      t,
      t,
    );
    return getOrder(id)!;
  },
);

export function getOrder(id: string): RechargeOrderRow | undefined {
  return db.prepare(`SELECT * FROM recharge_order WHERE id=?`).get(id) as
    | RechargeOrderRow
    | undefined;
}

// 账号隔离取单(API 层用):非本人非 admin → undefined → 路由 404。
export function getOrderForActor(
  id: string,
  tenantId: string,
  actingUserId: string,
  isAdmin: boolean,
): RechargeOrderRow | undefined {
  const scope = scopeByActor(actingUserId, isAdmin);
  return db
    .prepare(`SELECT * FROM recharge_order WHERE id=? AND tenant_id=?${scope.clause}`)
    .get(id, tenantId, ...scope.params) as RechargeOrderRow | undefined;
}

// 列订单台账(账号隔离)。admin 看全机构,creator 仅自己。
export function listOrdersForActor(
  tenantId: string,
  actingUserId: string,
  isAdmin: boolean,
  limit = 100,
): RechargeOrderRow[] {
  const scope = scopeByActor(actingUserId, isAdmin);
  // LEFT JOIN user 取发起人名;LEFT JOIN invoice_order+invoice 派生开票状态(走关联表,非死列)。
  return db
    .prepare(
      `SELECT o.*, COALESCE(u.display_name, u.username) AS actorName, iv.status AS invoiceStatus
         FROM recharge_order o
         LEFT JOIN user u ON o.created_by = u.id
         LEFT JOIN invoice_order io ON io.order_id = o.id
         LEFT JOIN invoice iv ON iv.id = io.invoice_id
        WHERE o.tenant_id=?${scope.clause.replace(/created_by/g, 'o.created_by')}
        ORDER BY o.created_at DESC, o.rowid DESC LIMIT ?`,
    )
    .all(tenantId, ...scope.params, limit) as RechargeOrderRow[];
}

// 超管侧:列某状态订单(默认 paid_claimed 待核对),全机构。
export function listOrdersByStatus(status: OrderStatus, limit = 200): RechargeOrderRow[] {
  return db
    .prepare(
      `SELECT * FROM recharge_order WHERE status=? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(status, limit) as RechargeOrderRow[];
}

// ── 订单状态迁移(单一原子来源)──
// 条件 UPDATE WHERE status=from,可选 patch 额外列。返 changes===1。
// 所有非建单的订单写都走这里;并发后来者 changes=0,天然幂等(钱路守卫基石)。
function transitionOrder(
  id: string,
  from: OrderStatus,
  to: OrderStatus,
  patch: Partial<
    Pick<RechargeOrderRow, 'receipt_key' | 'admin_note' | 'confirmed_by' | 'confirmed_at'>
  > = {},
  tenantId?: string,
): boolean {
  const sets: string[] = ['status=?', 'updated_at=?'];
  const vals: unknown[] = [to, now()];
  for (const [k, v] of Object.entries(patch)) {
    sets.push(`${k}=?`);
    vals.push(v);
  }
  const where: string[] = ['id=?', 'status=?'];
  vals.push(id, from);
  if (tenantId) {
    where.push('tenant_id=?');
    vals.push(tenantId);
  }
  const res = db
    .prepare(`UPDATE recharge_order SET ${sets.join(', ')} WHERE ${where.join(' AND ')}`)
    .run(...vals);
  return res.changes === 1;
}

// 用户「我已打款」:仅 pending_payment → paid_claimed(可选回单 key)。
// 驳回(rejected)是**终态**:平台驳回即不可再提交,用户需重新下单(用户决策:驳回无需重新支付)。
// 账号隔离:tenantId+本人 created_by 由 API 先 getOrderForActor 校验。
export function claimPaid(id: string, tenantId: string, receiptKey: string | null): boolean {
  return transitionOrder(
    id,
    'pending_payment',
    'paid_claimed',
    { receipt_key: receiptKey },
    tenantId,
  );
}

// 用户取消:仅 pending_payment(≥paid_claimed 前端已隐藏,这里守卫兑底)。
// rejected 是终态(不可取消也不可重提);用户要重买就重新下单。
export function cancelOrder(id: string, tenantId: string): boolean {
  return transitionOrder(id, 'pending_payment', 'cancelled', {}, tenantId);
}

// 超管驳回:paid_claimed → rejected(带原因)。
export function rejectOrder(id: string, adminId: string, note: string): boolean {
  return transitionOrder(id, 'paid_claimed', 'rejected', {
    admin_note: note,
    confirmed_by: adminId,
    confirmed_at: now(),
  });
}

// ★钱路核心★ 超管确认到账:paid_claimed → credited + 同事务 grant(credits+bonus)一次。
// 原子事务:条件 UPDATE changes===1 才 grant。双击/双超管并发 → 后来者 changes=0 → false → 不发。
// grant 带 order_id → credit_ledger 部分唯一索引兜底(即使逻辑漏判,第二次 INSERT 被 UNIQUE 拦)。
export const confirmAndCredit = db.transaction((id: string, adminId: string): boolean => {
  const order = getOrder(id);
  if (!order) return false;
  const ok = transitionOrder(id, 'paid_claimed', 'credited', {
    confirmed_by: adminId,
    confirmed_at: now(),
  });
  if (!ok) return false; // 非 paid_claimed(已处理/取消/并发后来者)→ 不发
  grant(
    order.tenant_id,
    order.credits + order.bonus_credits,
    `充值到账 #${order.order_no}`,
    order.id,
  );
  return true;
});

// ── 发票(一票多单)──
//
// 关联走 invoice_order(UNIQUE(order_id) 保证一单只进一张在途/已开发票);invoice 表无 order_id 列。
// 权限:租户 admin 发起申请(去 created_by 检查,可批本租户任意人的单);平台超管开具。
// 钱路:单一 validateInvoiceOrders 助手在「申请时 + 开具时」两处校验 —— 所含订单都 credited
//       且属本租户 + Σ金额 = 发票金额 + 非空。防漂移、防错开。

// 取某发票所含订单 id(派生)。
function invoiceOrderIds(invoiceId: string): string[] {
  return (
    db.prepare(`SELECT order_id FROM invoice_order WHERE invoice_id=?`).all(invoiceId) as {
      order_id: string;
    }[]
  ).map((r) => r.order_id);
}

// 给发票挂上 orderIds/orderNos(展示用)。
function hydrateInvoice(inv: InvoiceRow): InvoiceRow {
  const rows = db
    .prepare(
      `SELECT o.id, o.order_no FROM invoice_order io
         JOIN recharge_order o ON o.id = io.order_id
        WHERE io.invoice_id=?`,
    )
    .all(inv.id) as { id: string; order_no: string }[];
  inv.orderIds = rows.map((r) => r.id);
  inv.orderNos = rows.map((r) => r.order_no);
  return inv;
}

export function getInvoice(id: string): InvoiceRow | undefined {
  const inv = db.prepare(`SELECT * FROM invoice WHERE id=?`).get(id) as InvoiceRow | undefined;
  return inv ? hydrateInvoice(inv) : undefined;
}

// 单一钱路校验(申请时 + 开具时共用):所含订单都存在 + 属本租户 + credited + Σ金额=发票金额 + 非空。
// 不符抛 OrderError(API 层透传 400)。
function validateInvoiceOrders(orderIds: string[], tenantId: string, expectedAmount: number): void {
  if (orderIds.length === 0) throw new OrderError('NO_ORDERS', '请至少选择一个订单');
  let sum = 0;
  for (const oid of orderIds) {
    const o = getOrder(oid);
    if (!o || o.tenant_id !== tenantId) throw new OrderError('ORDER_NOT_FOUND', '订单不存在');
    if (o.status !== 'credited') throw new OrderError('ORDER_NOT_CREDITED', '仅已到账订单可开票');
    sum += o.price_yuan;
  }
  if (sum !== expectedAmount)
    throw new OrderError('AMOUNT_MISMATCH', '发票金额与所含订单金额之和不符');
}

// 取某订单关联的发票(订单页「开票信息」用;经 invoice_order 反查)。租户级,只限 tenant_id。
export function getInvoiceByOrder(orderId: string, tenantId: string): InvoiceRow | undefined {
  const inv = db
    .prepare(
      `SELECT i.* FROM invoice i
         JOIN invoice_order io ON io.invoice_id = i.id
        WHERE io.order_id = ? AND i.tenant_id = ?`,
    )
    .get(orderId, tenantId) as InvoiceRow | undefined;
  return inv ? hydrateInvoice(inv) : undefined;
}

export function getInvoiceForActor(
  id: string,
  tenantId: string,
  actingUserId: string,
  isAdmin: boolean,
): InvoiceRow | undefined {
  // 发票现在是租户级(admin 发起,代表机构)。creator 看本机构所有发票(只读),不按 created_by 隔离。
  // 故不用 scopeByActor 的 created_by 限制 —— 只限 tenant_id。actingUserId/isAdmin 保留签名兼容调用点。
  void actingUserId;
  void isAdmin;
  const inv = db
    .prepare(`SELECT * FROM invoice WHERE id=? AND tenant_id=?`)
    .get(id, tenantId) as InvoiceRow | undefined;
  return inv ? hydrateInvoice(inv) : undefined;
}

export function listInvoicesForActor(
  tenantId: string,
  actingUserId: string,
  isAdmin: boolean,
  limit = 100,
): InvoiceRow[] {
  void actingUserId;
  void isAdmin;
  const rows = db
    .prepare(
      `SELECT * FROM invoice WHERE tenant_id=?
       ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(tenantId, limit) as InvoiceRow[];
  return rows.map(hydrateInvoice);
}

export function listInvoicesByStatus(status: InvoiceStatus, limit = 200): InvoiceRow[] {
  const rows = db
    .prepare(`SELECT * FROM invoice WHERE status=? ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .all(status, limit) as InvoiceRow[];
  return rows.map(hydrateInvoice);
}

// 申请开票(一票多单)。租户 admin 发起:勾选 N 个本租户 credited 未占用订单 + 抬头。
//   事务原子:① pre-validate 每单未被其他发票占用 ② validateInvoiceOrders(credited + Σ金额 + 非空)
//   ③ 插 invoice + N 条 invoice_order。UNIQUE(order_id) 做并发后来者 backstop → 捕获映射 409。
export const requestInvoice = db.transaction(
  (params: {
    orderIds: string[];
    tenantId: string;
    userId: string; // 发起的 admin
    title: string;
    taxNo: string;
  }): InvoiceRow => {
    if (!params.title.trim()) throw new OrderError('TITLE_REQUIRED', '请填写发票抬头');
    if (!params.taxNo.trim()) throw new OrderError('TAXNO_REQUIRED', '请填写税号');
    if (params.orderIds.length === 0) throw new OrderError('NO_ORDERS', '请至少选择一个订单');

    // ① pre-validate:每单未被在途/已开发票占用(invoice_order UNIQUE 做并发兜底)。
    for (const oid of params.orderIds) {
      const occupied = db
        .prepare(`SELECT 1 FROM invoice_order WHERE order_id=?`)
        .get(oid);
      if (occupied) throw new OrderError('INVOICE_EXISTS', '所选订单中有已申请/已开票的');
    }

    // ② 金额 = Σ订单金额;校验所含订单都 credited + 属本租户 + 非空。
    let amount = 0;
    for (const oid of params.orderIds) {
      const o = getOrder(oid);
      if (!o || o.tenant_id !== params.tenantId) throw new OrderError('ORDER_NOT_FOUND', '订单不存在');
      amount += o.price_yuan;
    }
    validateInvoiceOrders(params.orderIds, params.tenantId, amount);

    // ③ 插 invoice + N 条关联。UNIQUE(order_id) 冲突(并发)→ 抛 → 整体回滚。
    const id = randomUUID();
    const t = now();
    db.prepare(
      `INSERT INTO invoice
         (id, tenant_id, created_by, title, tax_no, kind, amount_yuan, status, created_at)
       VALUES (?,?,?,?,?,'普票',?,'requested',?)`,
    ).run(id, params.tenantId, params.userId, params.title.trim(), params.taxNo.trim(), amount, t);
    const insOrder = db.prepare(`INSERT INTO invoice_order (invoice_id, order_id) VALUES (?,?)`);
    try {
      for (const oid of params.orderIds) insOrder.run(id, oid);
    } catch (e) {
      // 并发后来者撞 UNIQUE(order_id) → 映射为 409 业务错误(整事务回滚,不留孤儿发票)。
      throw new OrderError('INVOICE_EXISTS', '所选订单已被并发开票占用,请刷新重试');
    }
    return getInvoice(id)!;
  },
);

// 超管开具:requested → issued(发票号 + PDF)。开具前**重校**所含订单仍全 credited + Σ金额=发票金额
//   (用户「确认订单 + 审查入账」),不符拒开。自己重加载 invoice_order,不依赖外传订单。
export const issueInvoice = db.transaction(
  (id: string, invoiceNo: string, pdfKey: string | null): boolean => {
    const inv = db.prepare(`SELECT * FROM invoice WHERE id=?`).get(id) as InvoiceRow | undefined;
    if (!inv || inv.status !== 'requested') return false;
    // 重校(审查入账):所含订单仍全 credited + Σ金额=发票金额。
    validateInvoiceOrders(invoiceOrderIds(id), inv.tenant_id, inv.amount_yuan);
    const res = db
      .prepare(
        `UPDATE invoice SET status='issued', invoice_no=?, pdf_key=?, issued_at=?
         WHERE id=? AND status='requested'`,
      )
      .run(invoiceNo, pdfKey, now(), id);
    return res.changes === 1;
  },
);

// 超管驳回:删发票 + 删该发票所有 invoice_order 关联 → 订单释放回「未开票」可重选(架构 #1)。
export const rejectInvoice = db.transaction((id: string): boolean => {
  const res = db.prepare(`DELETE FROM invoice WHERE id=? AND status='requested'`).run(id);
  if (res.changes !== 1) return false;
  db.prepare(`DELETE FROM invoice_order WHERE invoice_id=?`).run(id);
  return true;
});

// ── 租户开票抬头资料(单例/租户;首次开票自动 upsert;仅 admin 编辑)──
export function getInvoiceProfile(tenantId: string): TenantInvoiceProfileRow | undefined {
  return db.prepare(`SELECT * FROM tenant_invoice_profile WHERE tenant_id=?`).get(tenantId) as
    | TenantInvoiceProfileRow
    | undefined;
}

export function upsertInvoiceProfile(p: {
  tenantId: string;
  title: string;
  taxNo: string;
  bankName?: string;
  bankAccount?: string;
  address?: string;
  phone?: string;
  updatedBy: string;
}): void {
  db.prepare(
    `INSERT INTO tenant_invoice_profile (tenant_id, title, tax_no, bank_name, bank_account, address, phone, updated_at, updated_by)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(tenant_id) DO UPDATE SET title=excluded.title, tax_no=excluded.tax_no,
       bank_name=excluded.bank_name, bank_account=excluded.bank_account, address=excluded.address,
       phone=excluded.phone, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
  ).run(
    p.tenantId,
    p.title,
    p.taxNo,
    p.bankName ?? null,
    p.bankAccount ?? null,
    p.address ?? null,
    p.phone ?? null,
    now(),
    p.updatedBy,
  );
}

// ── 对公收款信息(单例平台配置)──
export function getPayee(): PayeeSettingRow {
  const row = db.prepare(`SELECT * FROM payee_setting WHERE id=1`).get() as
    | PayeeSettingRow
    | undefined;
  return (
    row ?? {
      id: 1,
      payee_name: null,
      tax_no: null,
      bank_name: null,
      bank_account: null,
      updated_at: null,
    }
  );
}

export function setPayee(p: {
  payeeName: string;
  taxNo: string;
  bankName: string;
  bankAccount: string;
}): void {
  db.prepare(
    `INSERT INTO payee_setting (id, payee_name, tax_no, bank_name, bank_account, updated_at)
     VALUES (1,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET payee_name=excluded.payee_name, tax_no=excluded.tax_no,
       bank_name=excluded.bank_name, bank_account=excluded.bank_account, updated_at=excluded.updated_at`,
  ).run(p.payeeName, p.taxNo, p.bankName, p.bankAccount, now());
}
