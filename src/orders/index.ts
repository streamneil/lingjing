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
// 校验套餐存在 + enabled + price_yuan 非 NULL(拒面议),全快照落库。包在事务内出号 + 插入。
export const createOrder = db.transaction(
  (params: { tenantId: string; userId: string; planId: string }): RechargeOrderRow => {
    const plan = getPlan(params.planId);
    if (!plan || plan.enabled !== 1) throw new OrderError('PLAN_NOT_FOUND', '套餐不存在或已下架');
    if (plan.price_yuan == null)
      throw new OrderError('PLAN_NOT_PRICED', '面议套餐请联系商务,无法直接下单');

    const id = randomUUID();
    const orderNo = genOrderNo();
    const t = now();
    db.prepare(
      `INSERT INTO recharge_order
         (id, tenant_id, created_by, order_no, plan_id, plan_name, price_yuan, credits, bonus_credits,
          validity_months, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,'pending_payment',?,?)`,
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
  return db
    .prepare(
      `SELECT * FROM recharge_order WHERE tenant_id=?${scope.clause}
       ORDER BY created_at DESC, rowid DESC LIMIT ?`,
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

// 用户「我已打款」:pending_payment | rejected → paid_claimed(可选回单 key)。
// rejected 也可重提(驳回后再传)。账号隔离:tenantId+本人 created_by 由 API 先 getOrderForActor 校验。
export function claimPaid(id: string, tenantId: string, receiptKey: string | null): boolean {
  // 两个起点状态都允许 → 先试 pending,再试 rejected。条件 UPDATE 保证只命中一条。
  return (
    transitionOrder(id, 'pending_payment', 'paid_claimed', { receipt_key: receiptKey }, tenantId) ||
    transitionOrder(id, 'rejected', 'paid_claimed', { receipt_key: receiptKey }, tenantId)
  );
}

// 用户取消:仅 pending_payment | rejected(≥paid_claimed 前端已隐藏,这里守卫兑底)。
export function cancelOrder(id: string, tenantId: string): boolean {
  return (
    transitionOrder(id, 'pending_payment', 'cancelled', {}, tenantId) ||
    transitionOrder(id, 'rejected', 'cancelled', {}, tenantId)
  );
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

// ── 发票 ──

export function getInvoice(id: string): InvoiceRow | undefined {
  return db.prepare(`SELECT * FROM invoice WHERE id=?`).get(id) as InvoiceRow | undefined;
}

export function getInvoiceForActor(
  id: string,
  tenantId: string,
  actingUserId: string,
  isAdmin: boolean,
): InvoiceRow | undefined {
  const scope = scopeByActor(actingUserId, isAdmin);
  return db
    .prepare(`SELECT * FROM invoice WHERE id=? AND tenant_id=?${scope.clause}`)
    .get(id, tenantId, ...scope.params) as InvoiceRow | undefined;
}

export function listInvoicesForActor(
  tenantId: string,
  actingUserId: string,
  isAdmin: boolean,
  limit = 100,
): InvoiceRow[] {
  const scope = scopeByActor(actingUserId, isAdmin);
  return db
    .prepare(
      `SELECT * FROM invoice WHERE tenant_id=?${scope.clause}
       ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(tenantId, ...scope.params, limit) as InvoiceRow[];
}

export function listInvoicesByStatus(status: InvoiceStatus, limit = 200): InvoiceRow[] {
  return db
    .prepare(`SELECT * FROM invoice WHERE status=? ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .all(status, limit) as InvoiceRow[];
}

// 用户申请开票:仅 credited 订单,且该订单尚无 requested/issued 发票(防重复申请)。
// 金额取订单快照。事务保证「校验订单 credited + 无在途发票 + 插入」原子。
export const requestInvoice = db.transaction(
  (params: {
    orderId: string;
    tenantId: string;
    userId: string;
    title: string;
    taxNo: string;
  }): InvoiceRow => {
    const order = getOrder(params.orderId);
    if (!order || order.tenant_id !== params.tenantId || order.created_by !== params.userId)
      throw new OrderError('ORDER_NOT_FOUND', '订单不存在');
    if (order.status !== 'credited')
      throw new OrderError('ORDER_NOT_CREDITED', '仅已到账订单可开票');
    const existing = db
      .prepare(`SELECT id FROM invoice WHERE order_id=? AND status IN ('requested','issued')`)
      .get(params.orderId);
    if (existing) throw new OrderError('INVOICE_EXISTS', '该订单已申请开票');
    if (!params.title.trim()) throw new OrderError('TITLE_REQUIRED', '请填写发票抬头');
    if (!params.taxNo.trim()) throw new OrderError('TAXNO_REQUIRED', '请填写税号');

    const id = randomUUID();
    const t = now();
    db.prepare(
      `INSERT INTO invoice
         (id, order_id, tenant_id, created_by, title, tax_no, kind, amount_yuan, status, created_at)
       VALUES (?,?,?,?,?,?,'普票',?,'requested',?)`,
    ).run(
      id,
      params.orderId,
      params.tenantId,
      params.userId,
      params.title.trim(),
      params.taxNo.trim(),
      order.price_yuan,
      t,
    );
    return getInvoice(id)!;
  },
);

// 超管开票回填:requested → issued(发票号 + PDF key)。
export function issueInvoice(id: string, invoiceNo: string, pdfKey: string | null): boolean {
  const res = db
    .prepare(
      `UPDATE invoice SET status='issued', invoice_no=?, pdf_key=?, issued_at=?
       WHERE id=? AND status='requested'`,
    )
    .run(invoiceNo, pdfKey, now(), id);
  return res.changes === 1;
}

// 超管驳回开票:requested → 删行(退回 none,用户可重新申请)。带原因记审计由 API 层做。
export function rejectInvoice(id: string): boolean {
  return db.prepare(`DELETE FROM invoice WHERE id=? AND status='requested'`).run(id).changes === 1;
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
