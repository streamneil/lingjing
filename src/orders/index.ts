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
// ┌─ 订单状态机(2026-07 在线支付版;决策见 docs/designs/online-payments.md)────────────┐
// │                                                                                        │
// │  pending_payment ──claimPaid(对公,+回单)──▶ paid_claimed ──confirm──▶ credited(grant) │
// │        │                                        │  └─reject─▶ rejected(终态)           │
// │        │◀── 支付方式可切换(关旧 attempt)──┐    │                                       │
// │        ├──在线支付成功(回调/查单,applyPaymentSuccess)──▶ credited(grant,恰一次)      │
// │        │     (paid_claimed 也接受入账:钱到即入账,决策22)──▶ credited                  │
// │        ├──cancel / 超时 sweep(在线单先查单:已付→credited,未付→关单)──▶ cancelled     │
// │  credited ──超管退款(挂票拒退)──▶ refunding ──通道确认──▶ refunded(ledger 追回,终态)│
// │                                       └──通道失败──▶ credited(回退,attempt 记原因)    │
// │  幂等基石:transitionOrder 行级条件 UPDATE(WHERE status=from,changes===1)             │
// │           + credit_ledger(order_id) 对 grant/refund 各一个部分唯一索引双保险            │
// │  支付尝试(payment_attempt)状态机见 startPayment/applyPaymentSuccess 注释。            │
// └────────────────────────────────────────────────────────────────────────────────────────┘

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
  type PaymentAttemptRow,
  type PaymentAttemptStatus,
  type PaymentChannel,
  type PaymentScene,
} from '../db/index.js';
import { getPlan } from '../pricing/index.js';
import { grant, refundClawback } from '../credits/index.js';
import { writeAudit } from '../audit/index.js';
import {
  anyOnlineChannelAvailable,
  availableScenes,
  getProvider,
  notifyUrl,
  publicBaseUrl,
  recordReconDiff,
  yuanToFen,
} from '../payments/index.js';

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

    // ② 至少一种可付方式已配置(决策6):对公 payee 或任一在线通道。
    //    只配微信没配对公的部署形态也能建单;收银台按所选方式各自校验可用性。
    const payee = getPayee();
    const offlineReady = !!(payee.payee_name && payee.bank_account);
    if (!offlineReady && !anyOnlineChannelAvailable())
      throw new OrderError('PAYEE_NOT_READY', '平台尚未开通任何收款方式,请联系运营');

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

// ── 「订单管理」统一视图(超管侧;订单为主体,JOIN 租户/发起人/发票)──
// view='todo' = 运营待办:待确认 ∪ (已完成且开票中)。一个跨轴并集,不能靠单一 status 表达,故单列。
// 否则按 status('all' 不过滤)+ invoice 子筛选('any'|'none'|'requested'|'issued')组合。
export type AdminOrderView = 'todo' | OrderStatus | 'all';
export type AdminInvoiceFilter = 'any' | 'none' | 'requested' | 'issued';
export interface AdminOrderQuery {
  view?: AdminOrderView;
  invoice?: AdminInvoiceFilter;
  q?: string; // 关键词:租户名 或 订单号 模糊匹配(超管找特定单/租户)
  limit?: number;
  offset?: number;
}
// WHERE 构建(list 与 count 共用,口径一致)。需 JOIN o/t/iv 三表。
function buildAdminOrderWhere(opts: AdminOrderQuery): { clause: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.view === 'todo') {
    where.push(`(o.status='paid_claimed' OR (o.status='credited' AND iv.status='requested'))`);
  } else if (opts.view && opts.view !== 'all') {
    where.push(`o.status=?`);
    params.push(opts.view);
  }
  if (!opts.view || opts.view !== 'todo') {
    if (opts.invoice === 'none') where.push(`o.status='credited' AND iv.id IS NULL`); // 未开票=已完成且无发票
    else if (opts.invoice === 'requested') where.push(`iv.status='requested'`);
    else if (opts.invoice === 'issued') where.push(`iv.status='issued'`);
  }
  const q = opts.q?.trim();
  if (q) {
    where.push(`(t.name LIKE ? ESCAPE '\\' OR o.order_no LIKE ? ESCAPE '\\')`);
    const like = `%${q.replace(/[%_\\]/g, (m) => '\\' + m)}%`;
    params.push(like, like);
  }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

export function listOrdersForAdmin(opts: AdminOrderQuery = {}): RechargeOrderRow[] {
  const { clause, params } = buildAdminOrderWhere(opts);
  return db
    .prepare(
      `SELECT o.*, t.name AS tenantName, COALESCE(u.display_name, u.username) AS actorName,
              iv.id AS invoiceId, iv.status AS invoiceStatus, iv.invoice_no AS invoiceNo
         FROM recharge_order o
         LEFT JOIN tenant t ON t.id = o.tenant_id
         LEFT JOIN user u ON u.id = o.created_by
         LEFT JOIN invoice_order io ON io.order_id = o.id
         LEFT JOIN invoice iv ON iv.id = io.invoice_id
         ${clause}
        ORDER BY o.created_at DESC, o.rowid DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, opts.limit ?? 50, opts.offset ?? 0) as RechargeOrderRow[];
}

// 当前筛选下的总单数(分页用;与 list 同一 WHERE)。LIKE 用 ESCAPE 配合上面的转义。
export function countOrdersForAdmin(opts: AdminOrderQuery = {}): number {
  const { clause, params } = buildAdminOrderWhere(opts);
  return (db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM recharge_order o
         LEFT JOIN tenant t ON t.id = o.tenant_id
         LEFT JOIN invoice_order io ON io.order_id = o.id
         LEFT JOIN invoice iv ON iv.id = io.invoice_id
         ${clause}`,
    )
    .get(...params) as { n: number }).n;
}

// tab/筛选角标计数(一次性,供「订单管理」头部)。
export function adminOrderCounts(): {
  todo: number; all: number;
  byStatus: Record<OrderStatus, number>;
  byInvoice: { none: number; requested: number; issued: number };
} {
  const byStatus: Record<OrderStatus, number> = {
    pending_payment: 0, paid_claimed: 0, credited: 0, rejected: 0, cancelled: 0,
    refunding: 0, refunded: 0, // 在线支付退款态(决策5:新状态进所有枚举点)
  };
  for (const r of db.prepare(`SELECT status, COUNT(*) AS n FROM recharge_order GROUP BY status`).all() as {
    status: OrderStatus; n: number;
  }[]) {
    if (r.status in byStatus) byStatus[r.status] = r.n;
  }
  const all = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const todo = (db
    .prepare(
      `SELECT COUNT(*) AS n FROM recharge_order o
         LEFT JOIN invoice_order io ON io.order_id = o.id
         LEFT JOIN invoice iv ON iv.id = io.invoice_id
        WHERE o.status='paid_claimed' OR (o.status='credited' AND iv.status='requested')`,
    )
    .get() as { n: number }).n;
  // 发票子筛选(按订单计):未开票=已完成且无发票;开票中/已开票=订单关联发票的状态。
  const none = (db
    .prepare(
      `SELECT COUNT(*) AS n FROM recharge_order o
        WHERE o.status='credited' AND NOT EXISTS (SELECT 1 FROM invoice_order io WHERE io.order_id=o.id)`,
    )
    .get() as { n: number }).n;
  const invCount = (st: InvoiceStatus) =>
    (db
      .prepare(
        `SELECT COUNT(*) AS n FROM invoice_order io JOIN invoice iv ON iv.id=io.invoice_id WHERE iv.status=?`,
      )
      .get(st) as { n: number }).n;
  return { todo, all, byStatus, byInvoice: { none, requested: invCount('requested'), issued: invCount('issued') } };
}

// 订单详情(抽屉用):订单 + 经办超管名 + 关联发票(含同票兄弟单)。
export function getOrderDetailForAdmin(id: string): {
  order: RechargeOrderRow;
  confirmedByName: string | null;
  invoice: InvoiceRow | null;
  siblingOrders: { orderNo: string; priceYuan: number; isSelf: boolean }[];
} | null {
  const order = getOrder(id);
  if (!order) return null;
  const tn = db.prepare(`SELECT name FROM tenant WHERE id=?`).get(order.tenant_id) as { name: string } | undefined;
  order.tenantName = tn?.name ?? '(已删租户)';
  const u = db.prepare(`SELECT COALESCE(display_name, username) AS n FROM user WHERE id=?`).get(order.created_by) as
    | { n: string } | undefined;
  order.actorName = u?.n ?? null;
  let confirmedByName: string | null = null;
  if (order.confirmed_by) {
    const a = db.prepare(`SELECT username FROM platform_admin WHERE id=?`).get(order.confirmed_by) as
      | { username: string } | undefined;
    confirmedByName = a?.username ?? '(已删超管)';
  }
  const invoice = getInvoiceByOrder(id, order.tenant_id) ?? null;
  order.invoiceStatus = invoice?.status ?? null;
  order.invoiceId = invoice?.id ?? null;
  order.invoiceNo = invoice?.invoice_no ?? null;
  const siblingOrders = (invoice?.orderIds ?? []).map((oid) => {
    const so = getOrder(oid);
    return { orderNo: so?.order_no ?? oid, priceYuan: so?.price_yuan ?? 0, isSelf: oid === id };
  });
  return { order, confirmedByName, invoice, siblingOrders };
}

// ── 订单状态迁移(单一原子来源)──
// 条件 UPDATE WHERE status=from,可选 patch 额外列。返 changes===1。
// 所有非建单的订单写都走这里;并发后来者 changes=0,天然幂等(钱路守卫基石)。
function transitionOrder(
  id: string,
  from: OrderStatus,
  to: OrderStatus,
  patch: Partial<
    Pick<
      RechargeOrderRow,
      'receipt_key' | 'admin_note' | 'confirmed_by' | 'confirmed_at' | 'payment_method'
    > // payment_method:在线支付成功时锁定(决策28,不许绕单一门裸 UPDATE)
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
// 在线互斥(决策22):有在途在线支付时拒绝对公申报(先取消在线支付)—— 但即使漏拦,
// 钱到即入账兜底:applyPaymentSuccess 也接受 paid_claimed → credited。
export function claimPaid(id: string, tenantId: string, receiptKey: string | null): boolean {
  if (pendingAttemptForOrder(id))
    throw new OrderError('ONLINE_IN_FLIGHT', '有进行中的在线支付,请先返回收银台取消或完成支付');
  return transitionOrder(
    id,
    'pending_payment',
    'paid_claimed',
    { receipt_key: receiptKey, payment_method: 'offline_bank' },
    tenantId,
  );
}

// 用户取消:仅 pending_payment(≥paid_claimed 前端已隐藏,这里守卫兑底)。
// rejected 是终态(不可取消也不可重提);用户要重买就重新下单。
export function cancelOrder(id: string, tenantId: string): boolean {
  return transitionOrder(id, 'pending_payment', 'cancelled', {}, tenantId);
}

// 待支付超时自动取消。默认 2 小时 —— 兼顾对公转账的财务处理时间(15 分钟太短会误杀真实单),
// 又不让废弃单长期堆在「待支付」。如需再调改这个常量即可(如 24h = 24*60*60*1000)。
// 仅取消 pending_payment(尚未「我已打款」、未预扣积分,取消无副作用);paid_claimed 不动。
// 在线单防误杀:仍有 pending attempt 的订单跳过 —— 先由 sweepExpiredAttempts 查单定生死
// (attempt 过期锚点 = min(场景TTL, 订单剩余TTL) ≤ 订单 TTL,正常时序不会走到这条护栏)。
export const PENDING_PAYMENT_TTL_MS = 2 * 60 * 60 * 1000;
export function cancelStalePendingOrders(maxAgeMs: number = PENDING_PAYMENT_TTL_MS): number {
  const cutoff = now() - maxAgeMs;
  const rows = db
    .prepare(
      `SELECT id, tenant_id FROM recharge_order o
        WHERE status='pending_payment' AND created_at < ?
          AND NOT EXISTS (SELECT 1 FROM payment_attempt a WHERE a.order_id=o.id AND a.status='pending')`,
    )
    .all(cutoff) as { id: string; tenant_id: string }[];
  let n = 0;
  for (const r of rows) {
    if (transitionOrder(r.id, 'pending_payment', 'cancelled', { admin_note: '待支付超时自动取消(超过 2 小时未支付)' }, r.tenant_id)) n++;
  }
  return n;
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
// 金额合计按「分」整数相加再比对:套餐已放开到 0.01 元,浮点元直加会出
// 0.01+0.01+0.01 = 0.030000000000000002 这类票账不平假差异(加法顺序还不可控)。
function validateInvoiceOrders(orderIds: string[], tenantId: string, expectedAmount: number): void {
  if (orderIds.length === 0) throw new OrderError('NO_ORDERS', '请至少选择一个订单');
  let sumFen = 0;
  for (const oid of orderIds) {
    const o = getOrder(oid);
    if (!o || o.tenant_id !== tenantId) throw new OrderError('ORDER_NOT_FOUND', '订单不存在');
    if (o.status !== 'credited') throw new OrderError('ORDER_NOT_CREDITED', '仅已到账订单可开票');
    sumFen += Math.round(o.price_yuan * 100);
  }
  if (sumFen !== Math.round(expectedAmount * 100))
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

    // ② 金额 = Σ订单金额(分整数相加防浮点漂移,存回干净的元值);校验所含订单都 credited + 属本租户 + 非空。
    let amountFen = 0;
    for (const oid of params.orderIds) {
      const o = getOrder(oid);
      if (!o || o.tenant_id !== params.tenantId) throw new OrderError('ORDER_NOT_FOUND', '订单不存在');
      amountFen += Math.round(o.price_yuan * 100);
    }
    const amount = amountFen / 100;
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
  (id: string, invoiceNo: string | null, pdfKey: string | null): boolean => { // 发票号选填:空=null(列表回退「下载发票」)
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

// ════════════════════════════════════════════════════════════════════════════
// 在线支付(微信/支付宝)—— 设计:docs/designs/online-payments.md(31 条定稿决策)
//
// ┌─ payment_attempt 状态机 ────────────────────────────────────────────────┐
// │ pending ──支付成功(回调/查单)──▶ paid ──退款──▶ refunding ──▶ refunded │
// │    │                                              └─失败─▶ refund_failed │
// │    ├──切换通道/用户取消──▶ closed(通道侧已关单)                          │
// │    └──超时 sweep(先查单!已付→paid,未付→关单)──▶ expired                │
// │ 不变量:UNIQUE(order_id) WHERE pending —— 每单恰一在途码(决策23)         │
// │        id = out_trade_no(32 hex,决策12/18);金额=整数分快照              │
// └──────────────────────────────────────────────────────────────────────────┘
// ════════════════════════════════════════════════════════════════════════════

/** 场景码有效期:h5_url 官方 5 分钟;native code_url/支付宝 page 给 2h(与订单 TTL 同级);wap 15 分钟。 */
const SCENE_TTL_MS: Record<PaymentScene, number> = {
  native: 2 * 60 * 60 * 1000,
  h5: 5 * 60 * 1000,
  page: 2 * 60 * 60 * 1000,
  wap: 15 * 60 * 1000,
};

export function getAttempt(id: string): PaymentAttemptRow | undefined {
  return db.prepare(`SELECT * FROM payment_attempt WHERE id=?`).get(id) as
    | PaymentAttemptRow
    | undefined;
}

export function pendingAttemptForOrder(orderId: string): PaymentAttemptRow | undefined {
  return db
    .prepare(`SELECT * FROM payment_attempt WHERE order_id=? AND status='pending' LIMIT 1`)
    .get(orderId) as PaymentAttemptRow | undefined;
}

/** 最近一笔已收款的尝试(退款对象,决策11)。refund_failed 可重试,refunding 在途。 */
export function paidAttemptForOrder(orderId: string): PaymentAttemptRow | undefined {
  return db
    .prepare(
      `SELECT * FROM payment_attempt WHERE order_id=? AND status IN ('paid','refunding','refund_failed')
       ORDER BY paid_at DESC, rowid DESC LIMIT 1`,
    )
    .get(orderId) as PaymentAttemptRow | undefined;
}

/** attempt 状态迁移(镜 transitionOrder:行级条件 UPDATE,changes===1;from 允许多态)。 */
function transitionAttempt(
  id: string,
  from: PaymentAttemptStatus[],
  to: PaymentAttemptStatus,
  patch: Partial<Pick<PaymentAttemptRow, 'txn_id' | 'paid_at' | 'refund_no' | 'refund_at' | 'fail_reason' | 'code_url'>> = {},
): boolean {
  const sets: string[] = ['status=?', 'updated_at=?'];
  const vals: unknown[] = [to, now()];
  for (const [k, v] of Object.entries(patch)) {
    sets.push(`${k}=?`);
    vals.push(v);
  }
  vals.push(id, ...from);
  const res = db
    .prepare(
      `UPDATE payment_attempt SET ${sets.join(', ')} WHERE id=? AND status IN (${from.map(() => '?').join(',')})`,
    )
    .run(...vals);
  return res.changes === 1;
}

const channelName = (c: PaymentChannel) => (c === 'wechat' ? '微信支付' : '支付宝');

export type StartPaymentResult =
  | { alreadyPaid: true }
  | {
      alreadyPaid?: false;
      attemptId: string;
      kind: 'qr' | 'redirect';
      payload: string;
      expiresAt: number;
      channel: PaymentChannel;
      scene: PaymentScene;
    };

/**
 * 发起在线支付(收银台「去支付」/切换通道/码过期刷新共用)。
 * - 复用未过期同通道同场景在途码(双击防抖);
 * - 切换/刷新:先查旧码(已付→入账终止),再通道关单 + 本地 closed,同守卫下插新(决策2A/23);
 * - expires_at = min(场景TTL, 订单剩余TTL) 且传给通道 time_expire(决策24)。
 */
export async function startPayment(params: {
  orderId: string;
  tenantId: string;
  channel: PaymentChannel;
  scene: PaymentScene;
  clientIp: string;
}): Promise<StartPaymentResult> {
  const order = getOrder(params.orderId);
  if (!order || order.tenant_id !== params.tenantId)
    throw new OrderError('ORDER_NOT_FOUND', '订单不存在');
  if (order.status !== 'pending_payment')
    throw new OrderError('ORDER_NOT_PAYABLE', '订单当前状态不可在线支付');
  if (!availableScenes(params.channel).includes(params.scene))
    throw new OrderError('CHANNEL_UNAVAILABLE', `${channelName(params.channel)}暂未开通,请选择其他付款方式`);
  const provider = getProvider(params.channel);
  if (!provider) throw new OrderError('CHANNEL_UNAVAILABLE', `${channelName(params.channel)}暂未开通`);

  const amountFen = yuanToFen(order.price_yuan);
  const orderDeadline = order.created_at + PENDING_PAYMENT_TTL_MS;
  const expiresAt = Math.min(now() + SCENE_TTL_MS[params.scene], orderDeadline);
  if (expiresAt - now() < 30_000)
    throw new OrderError('ORDER_EXPIRING', '订单即将超时,请取消后重新下单');

  // 在途码处理:复用 or 查单→关单→作废。
  const existing = pendingAttemptForOrder(order.id);
  if (existing) {
    const sameTarget =
      existing.channel === params.channel && existing.scene === params.scene && !!existing.code_url;
    if (sameTarget && existing.expires_at - now() > 60_000) {
      return {
        attemptId: existing.id,
        kind: existing.scene === 'native' ? 'qr' : 'redirect',
        payload: existing.code_url!,
        expiresAt: existing.expires_at,
        channel: existing.channel,
        scene: existing.scene,
      };
    }
    const oldProvider = getProvider(existing.channel);
    if (oldProvider) {
      const q = await oldProvider.queryPayment(existing.id); // 先查单:扫码已付时切换 → 入账而非关单
      if (q.status === 'paid') {
        applyPaymentSuccess(existing.channel, existing.id, q.txnId ?? '', q.paidAmountFen ?? existing.amount_fen);
        return { alreadyPaid: true };
      }
      await oldProvider.closePayment(existing.id); // 失败即抛:不能在旧码可能仍活时发新码(双收款防线)
    }
    transitionAttempt(existing.id, ['pending'], 'closed');
  }

  const attemptId = randomUUID().replace(/-/g, ''); // 32 hex(微信 out_trade_no ≤32 字符,决策18)
  try {
    db.prepare(
      `INSERT INTO payment_attempt (id, order_id, tenant_id, channel, scene, amount_fen, status, expires_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,'pending',?,?,?)`,
    ).run(attemptId, order.id, order.tenant_id, params.channel, params.scene, amountFen, expiresAt, now(), now());
  } catch {
    // UNIQUE(order_id) WHERE pending:并发 startPayment 后来者(决策23)
    throw new OrderError('CONCURRENT_PAYMENT', '支付发起中,请勿重复操作');
  }

  const base = publicBaseUrl()!; // availableScenes 非空已保证
  let created;
  try {
    created = await provider.createPayment({
      attemptId,
      amountFen,
      description: `灵镜积分充值-${order.plan_name}`.slice(0, 120),
      clientIp: params.clientIp,
      scene: params.scene,
      notifyUrl: notifyUrl(params.channel),
      returnUrl: `${base}/pay.html?order=${encodeURIComponent(order.id)}`,
      expiresAt,
    });
  } catch (e) {
    // 下单失败:attempt 作废,订单无损;用户看「下单失败,请重试或改用对公转账」。
    transitionAttempt(attemptId, ['pending'], 'closed', {
      fail_reason: e instanceof Error ? e.message.slice(0, 300) : String(e),
    });
    throw e;
  }
  db.prepare(`UPDATE payment_attempt SET code_url=?, updated_at=? WHERE id=?`).run(created.payload, now(), attemptId);
  // payment_method 切换记录(pending 期可变,支付成功时最终锁定,决策2A)。
  db.prepare(`UPDATE recharge_order SET payment_method=?, updated_at=? WHERE id=? AND status='pending_payment'`)
    .run(params.channel, now(), order.id);

  return { attemptId, kind: created.kind, payload: created.payload, expiresAt, channel: params.channel, scene: params.scene };
}

export type ApplyPaymentOutcome = 'credited' | 'duplicate' | 'recorded_diff';

/**
 * ★钱路核心★ 在线支付成功入账(回调 / 主动查单 / sweep 查单 / 切换前查单 四路共用)。
 * 幂等矩阵(决策4/22/25):
 *   同 out_trade_no + 同 txn 重复投递      → 'duplicate'(通道 ACK,静默)
 *   金额 ≠ attempt 快照                     → 差异表 amount_mismatch,不入账(ACK,已记录)
 *   订单 pending_payment / paid_claimed     → credited + grant(行级条件 UPDATE 恰一次)
 *   订单 已取消/已入账(他码)/退款中        → 差异表 status_mismatch,不入账(超管退款闭环处理)
 *   未知 out_trade_no                        → 差异表 missing_local
 * 整体 db.transaction:attempt 迁移、订单迁移、grant、差异记录原子一致。
 */
export const applyPaymentSuccess = db.transaction(
  (channel: PaymentChannel, attemptId: string, txnId: string, paidAmountFen: number): ApplyPaymentOutcome => {
    const attempt = getAttempt(attemptId);
    if (!attempt || attempt.channel !== channel) {
      recordReconDiff({
        channel,
        kind: 'missing_local',
        outTradeNo: attemptId,
        txnId,
        detail: { paidAmountFen, reason: attempt ? 'channel_mismatch' : 'unknown_out_trade_no' },
      });
      return 'recorded_diff';
    }
    if (paidAmountFen !== attempt.amount_fen) {
      recordReconDiff({
        channel,
        kind: 'amount_mismatch',
        outTradeNo: attemptId,
        txnId,
        detail: { expectedFen: attempt.amount_fen, paidFen: paidAmountFen, orderId: attempt.order_id },
      });
      return 'recorded_diff';
    }
    // 收款是通道侧事实:pending/expired/closed 的码收到钱都先记 paid(迟到支付,决策「钱只进不丢」)。
    const moved = transitionAttempt(attemptId, ['pending', 'expired', 'closed'], 'paid', {
      txn_id: txnId,
      paid_at: now(),
    });
    if (!moved) {
      const fresh = getAttempt(attemptId)!;
      if (fresh.txn_id === txnId) return 'duplicate'; // 通道正常重试投递
      recordReconDiff({
        channel,
        kind: 'status_mismatch',
        outTradeNo: attemptId,
        txnId,
        detail: { reason: 'double_collection_same_attempt', existingTxn: fresh.txn_id, attemptStatus: fresh.status },
      });
      return 'recorded_diff';
    }
    const order = getOrder(attempt.order_id)!;
    const lockPatch = { confirmed_at: now(), payment_method: attempt.channel } as const;
    const credited =
      transitionOrder(order.id, 'pending_payment', 'credited', lockPatch) ||
      transitionOrder(order.id, 'paid_claimed', 'credited', lockPatch); // 决策22:钱到即入账
    if (credited) {
      grant(
        order.tenant_id,
        order.credits + order.bonus_credits,
        `充值到账 #${order.order_no}(${channelName(attempt.channel)})`,
        order.id,
      );
      // 系统 actor 审计(决策30):回调无请求上下文,线上入账不从审计轨迹消失。
      writeAudit(order.tenant_id, null, 'online_payment_credited', `${order.order_no}|${channel}|${txnId}`, null, 'system');
      return 'credited';
    }
    // 订单不可入账(已取消/他码已入账/退款中):钱已收,落差异表由超管原路退款(决策25)。
    recordReconDiff({
      channel,
      kind: 'status_mismatch',
      outTradeNo: attemptId,
      txnId,
      detail: { reason: `paid_on_${order.status}`, orderNo: order.order_no, orderId: order.id },
    });
    return 'recorded_diff';
  },
);

/** 用户触发主动查单(「我已支付」点击 + H5 返回页,决策8;限流在 API 层)。 */
export async function checkPaymentNow(orderId: string, tenantId: string): Promise<OrderStatus> {
  const order = getOrder(orderId);
  if (!order || order.tenant_id !== tenantId) throw new OrderError('ORDER_NOT_FOUND', '订单不存在');
  const attempt = pendingAttemptForOrder(orderId);
  if (attempt) {
    const provider = getProvider(attempt.channel);
    if (provider) {
      const q = await provider.queryPayment(attempt.id);
      if (q.status === 'paid')
        applyPaymentSuccess(attempt.channel, attempt.id, q.txnId ?? '', q.paidAmountFen ?? attempt.amount_fen);
    }
  }
  return getOrder(orderId)!.status;
}

/** 用户取消订单(在线版):在途码先查单(已付→入账,不可取消)再通道关单,最后取消订单。 */
export async function cancelOrderWithAttempt(
  id: string,
  tenantId: string,
): Promise<{ cancelled: boolean; credited?: boolean }> {
  const attempt = pendingAttemptForOrder(id);
  if (attempt) {
    const provider = getProvider(attempt.channel);
    if (provider) {
      const q = await provider.queryPayment(attempt.id);
      if (q.status === 'paid') {
        applyPaymentSuccess(attempt.channel, attempt.id, q.txnId ?? '', q.paidAmountFen ?? attempt.amount_fen);
        return { cancelled: false, credited: true };
      }
      await provider.closePayment(attempt.id);
    }
    transitionAttempt(attempt.id, ['pending'], 'closed');
  }
  return { cancelled: cancelOrder(id, tenantId) };
}

// ── 退款闭环(决策5/10/11/16/21/28)──

export type StartRefundOutcome = 'refunded' | 'refunding' | 'failed';

/**
 * 超管发起整单退款。时序钉死(决策21,堵 TOCTOU):
 *   同事务「挂票检查 + credited→refunding + attempt→refunding」 **先于** 通道调用;
 *   通道同步成功(支付宝)→ 立即确认;受理中(微信)→ 等退款异步通知;
 *   通道失败 → refunding→credited 回退 + attempt→refund_failed(订单不卡死)。
 */
/** 退款单号:RF + attempt id 前 30 位 = 32 字符(微信 out_refund_no 上限 64,支付宝 out_request_no 64;
 *  取 32 与 out_trade_no 同宽,便于人工对照)。同 attempt 重试复用同号 → 通道侧幂等。 */
function refundNoFor(attempt: PaymentAttemptRow): string {
  return attempt.refund_no ?? `RF${attempt.id.slice(0, 30)}`;
}

/** refunding 卡死判定:进程在「本地置 refunding」与「通道调用」之间崩溃时,退款从未发出,
 *  但守卫会永久拒绝重试。超过此时长的 refunding 视为可重驱(同 refund_no 通道幂等,安全)。 */
const REFUND_STALE_MS = 10 * 60 * 1000;

export async function startRefund(orderId: string, adminId: string, reason: string): Promise<StartRefundOutcome> {
  const order = getOrder(orderId);
  if (!order) throw new OrderError('ORDER_NOT_FOUND', '订单不存在');
  const attempt = paidAttemptForOrder(orderId);
  if (!attempt || !attempt.txn_id)
    throw new OrderError('NO_ONLINE_PAYMENT', '该订单无在线支付流水,不能原路退款(对公单请线下处理)');

  const refundNo = refundNoFor(attempt);
  // 崩溃恢复:refunding 已停滞 → 跳过本地迁移(订单/attempt 已在 refunding),直接重驱通道退款。
  if (attempt.status === 'refunding') {
    if (now() - attempt.updated_at < REFUND_STALE_MS)
      throw new OrderError('REFUND_IN_FLIGHT', '退款处理中,请稍候');
    console.warn(`[支付] 检测到停滞的退款(${attempt.id}),重驱通道退款(同 refund_no 幂等)`);
    return executeChannelRefund(attempt.id, refundNo, reason);
  }

  db.transaction(() => {
    // 挂票拒退(决策5):在途/已开发票都拦,提示先驳回发票(避免票账不平/永远开不出的发票)。
    const occupied = db.prepare(`SELECT 1 FROM invoice_order WHERE order_id=?`).get(orderId);
    if (occupied) throw new OrderError('INVOICE_ATTACHED', '该订单已关联发票,请先驳回对应发票再退款');
    const orderMoved = transitionOrder(orderId, 'credited', 'refunding', {
      admin_note: `退款:${reason}`.slice(0, 200),
      confirmed_by: adminId,
    });
    if (!orderMoved) throw new OrderError('ORDER_NOT_REFUNDABLE', '仅已到账订单可退款(或已有退款在途)');
    const attemptMoved = transitionAttempt(attempt.id, ['paid', 'refund_failed'], 'refunding', {
      refund_no: refundNo,
    });
    if (!attemptMoved) throw new OrderError('REFUND_IN_FLIGHT', '退款处理中,请稍候');
  })();

  return executeChannelRefund(attempt.id, refundNo, reason);
}

/**
 * 对「已收款但订单不可入账」的尝试退款(差异表处理入口;无 ledger 追回,决策11)。
 *
 * 守卫(评审 CRITICAL):若该 attempt 正是给订单入账的那一笔(订单 credited/refunding/refunded),
 * 走这条路会把钱退了却不追回积分 —— 租户白拿积分。这种单必须走订单级 startRefund(同事务追 ledger)。
 * 双重收款差异(同 attempt 两个交易号)通道侧只认一个 out_trade_no,无法按单号退第二笔,
 * 需在商户后台人工原路退回 —— 这里明确拒绝并提示,而不是退错那一笔。
 */
export async function startRefundForAttempt(attemptId: string, reason: string): Promise<StartRefundOutcome> {
  const attempt = getAttempt(attemptId);
  if (!attempt || !attempt.txn_id) throw new OrderError('ATTEMPT_NOT_FOUND', '支付流水不存在或未收款');
  const order = getOrder(attempt.order_id);
  if (order && (order.status === 'credited' || order.status === 'refunding' || order.status === 'refunded'))
    throw new OrderError(
      'ATTEMPT_CREDITED_ORDER',
      '该流水已给订单入账:请用订单「原路退款」(会同时扣回积分);重复收款需在商户后台人工退回',
    );
  const refundNo = refundNoFor(attempt);
  const moved = transitionAttempt(attemptId, ['paid', 'refund_failed'], 'refunding', { refund_no: refundNo });
  if (!moved) throw new OrderError('REFUND_IN_FLIGHT', '退款处理中或已退款');
  return executeChannelRefund(attemptId, refundNo, reason);
}

async function executeChannelRefund(attemptId: string, refundNo: string, reason: string): Promise<StartRefundOutcome> {
  const attempt = getAttempt(attemptId)!;
  const provider = getProvider(attempt.channel);
  if (!provider) {
    applyRefundResult(attemptId, false, '通道未配置,无法发起退款');
    return 'failed';
  }
  let result;
  try {
    result = await provider.refund({
      attemptId,
      txnId: attempt.txn_id!,
      refundNo,
      amountFen: attempt.amount_fen,
      reason,
      notifyUrl: notifyUrl(attempt.channel),
    });
  } catch (e) {
    applyRefundResult(attemptId, false, e instanceof Error ? e.message.slice(0, 300) : String(e));
    return 'failed';
  }
  if (result.status === 'succeeded') {
    applyRefundResult(attemptId, true);
    return 'refunded';
  }
  if (result.status === 'processing') return 'refunding'; // 微信:等退款异步通知驱动 applyRefundResult
  applyRefundResult(attemptId, false, result.reason);
  return 'failed';
}

/**
 * 退款结果落账(支付宝同步 / 微信退款通知 共用;sync 事务)。
 * 成功:attempt→refunded;订单曾 credited(refunding 态)→ refunded + ledger 追回(唯一索引双保险);
 *       订单非 refunding(差异单 attempt-only 退款)→ 只记 attempt,不动订单不追 ledger(决策11)。
 * 失败:attempt→refund_failed(存原因);订单 refunding→credited 回退(不卡死,决策21)。
 */
export const applyRefundResult = db.transaction(
  (attemptId: string, ok: boolean, failReason?: string): 'refunded' | 'failed' | 'duplicate' => {
    const attempt = getAttempt(attemptId);
    if (!attempt) return 'duplicate';
    if (ok) {
      const moved = transitionAttempt(attemptId, ['refunding'], 'refunded', { refund_at: now() });
      if (!moved) return 'duplicate'; // 重复通知
      const order = getOrder(attempt.order_id)!;
      const orderMoved = transitionOrder(order.id, 'refunding', 'refunded', {});
      if (orderMoved) {
        refundClawback(
          order.tenant_id,
          order.credits + order.bonus_credits,
          `退款追回 #${order.order_no}(${channelName(attempt.channel)})`,
          order.id,
        );
      }
      writeAudit(attempt.tenant_id, null, 'online_payment_refunded', `${attempt.order_id}|${attempt.refund_no ?? ''}`, null, 'system');
      return 'refunded';
    }
    transitionAttempt(attemptId, ['refunding'], 'refund_failed', { fail_reason: failReason?.slice(0, 300) ?? '通道退款失败' });
    transitionOrder(attempt.order_id, 'refunding', 'credited', {}); // 回退,订单不卡死
    return 'failed';
  },
);

// ── 在线单超时 sweep(决策13/24/27):先查单(已付→入账),未付→通道关单→expired ──

let sweepInFlight = false; // 重入守卫:通道慢于 tick 时跳过本轮(决策27)

/** 每 tick 处理的在途码上限:每单最多 2 次外呼(查单+关单),通道 15s 超时 —— 不设上限时
 *  一次通道抖动就能让单 tick 跑成分钟级,把后面的查单和本地取消全饿死。剩余的下轮自然接上。 */
const SWEEP_BATCH = 40;

export async function sweepExpiredAttempts(): Promise<void> {
  const rows = db
    .prepare(
      `SELECT id FROM payment_attempt WHERE status='pending' AND expires_at < ?
        ORDER BY expires_at ASC LIMIT ?`,
    )
    .all(now(), SWEEP_BATCH) as { id: string }[];
  for (const r of rows) {
    try {
      const attempt = getAttempt(r.id);
      if (!attempt || attempt.status !== 'pending') continue;
      const provider = getProvider(attempt.channel);
      if (!provider) {
        // 通道已下线:本地过期;若真付了款,对账兜底(missing_local 现形)。
        transitionAttempt(r.id, ['pending'], 'expired');
        continue;
      }
      const q = await provider.queryPayment(r.id);
      if (q.status === 'paid') {
        // sweep 查单路径完整具备入账能力(决策13:私有化内网收不到回调,这是唯一入账路径)。
        applyPaymentSuccess(attempt.channel, r.id, q.txnId ?? '', q.paidAmountFen ?? attempt.amount_fen);
        continue;
      }
      await provider.closePayment(r.id);
      transitionAttempt(r.id, ['pending'], 'expired');
    } catch (e) {
      // 单单隔离:一单通道异常不拖垮整批,下一 tick 重试(决策27)。
      console.warn(`[支付] sweep 处理尝试 ${r.id} 失败(下轮重试):`, e instanceof Error ? e.message : e);
    }
  }
}

/**
 * 在途未过期码的主动查单兜底(决策13 的完整实现)。
 * 回调可能整体不可达(验签配置错、防火墙挡微信来源、私有化内网)——此前只有「过期时」
 * 才查单,回调一丢用户就干等到码过期(2026-07-14 真实事故:支付成功页面长期不动)。
 * 现在每个 sweep tick(60s)对所有在途码查一次:已付 → 立即入账,前端 3s 本地轮询跟进变绿。
 * 跳过创建 <30s 的码(用户可能还没扫完,回调大概率会先到,省无谓通道调用)。
 */
export async function pollActivePendingAttempts(): Promise<void> {
  const t = now();
  // 轮转公平 + 批上限:按 updated_at 最旧优先(每次查单会刷新 updated_at → 天然 round-robin),
  // 单 tick 至多 SWEEP_BATCH 单,避免大量在途码时外呼扇出无界。
  const rows = db
    .prepare(
      `SELECT id FROM payment_attempt WHERE status='pending' AND expires_at >= ? AND created_at < ?
        ORDER BY updated_at ASC LIMIT ?`,
    )
    .all(t, t - 30_000, SWEEP_BATCH) as { id: string }[];
  for (const r of rows) {
    try {
      const attempt = getAttempt(r.id);
      if (!attempt || attempt.status !== 'pending') continue;
      const provider = getProvider(attempt.channel);
      if (!provider) continue;
      const q = await provider.queryPayment(r.id);
      if (q.status === 'paid') {
        applyPaymentSuccess(attempt.channel, r.id, q.txnId ?? '', q.paidAmountFen ?? attempt.amount_fen);
      } else {
        // 记一次「已轮询」时间戳:排序键前移,保证多单时人人轮得到(不改状态)。
        db.prepare(`UPDATE payment_attempt SET updated_at=? WHERE id=? AND status='pending'`).run(now(), r.id);
      }
      // pending/not_found:继续等回调或下轮;closed:留给过期 sweep 统一收尾。
    } catch (e) {
      console.warn(`[支付] 在途码查单失败 ${r.id}(下轮重试):`, e instanceof Error ? e.message : e);
    }
  }
}

/** 订单/支付统一 sweep(server 60s tick 调用;in-flight 守卫防重入)。 */
export async function sweepOrders(): Promise<number> {
  if (sweepInFlight) return 0;
  sweepInFlight = true;
  try {
    // 本地超时取消先跑(同步 SQLite,微秒级):它不依赖通道结果(已用 NOT EXISTS 排除在途码),
    // 放在外呼之后会被通道抖动整轮饿死。
    const cancelled = cancelStalePendingOrders();
    await sweepExpiredAttempts();
    await pollActivePendingAttempts();
    return cancelled;
  } finally {
    sweepInFlight = false;
  }
}
