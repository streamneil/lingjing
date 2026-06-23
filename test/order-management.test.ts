// 「订单管理」统一视图(超管侧)—— listOrdersForAdmin / adminOrderCounts / getOrderDetailForAdmin。
// 覆盖:todo 跨轴并集(待确认 ∪ 已完成且开票中)、发票子筛选、计数、合并发票兄弟单。
process.env.DB_FILE = ':memory:'; // 必须在 import db 之前:独立内存库,不污染真实 lingjing.db
import { describe, it, expect, beforeAll } from 'vitest';

const { createTenant, createUser } = await import('../src/auth/index.js');
const { createPlan } = await import('../src/pricing/index.js');
const {
  createOrder, claimPaid, cancelOrder, rejectOrder, confirmAndCredit,
  requestInvoice, issueInvoice, setPayee,
  listOrdersForAdmin, countOrdersForAdmin, adminOrderCounts, getOrderDetailForAdmin,
  cancelStalePendingOrders,
} = await import('../src/orders/index.js');

let tId = '', adminU = '', PADMIN = 'padmin-test';
// 订单 id
let oReq = '', oIssued = '', oPaid = '', oPending = '', oRejected = '', oCancelled = '', oNoInvoice = '';
let oMergeA = '', oMergeB = '';
// adminOrderCounts 是全局(跨租户)。测试库跨文件共享 → 用 baseline 取增量,排除其它测试数据干扰。
let base: ReturnType<typeof adminOrderCounts>;

beforeAll(async () => {
  base = adminOrderCounts();
  tId = createTenant('订单管理台').id;
  adminU = (await createUser(tId, 'omadmin', 'pw123456', 'admin')).id;
  setPayee({ payeeName: '测试公司', taxNo: 'TAX', bankName: '测试行', bankAccount: '6222' });
  const plan = (name: string, price: number) => createPlan({ name, priceYuan: price, credits: price * 10 }).id;

  const credit = (oid: string) => { claimPaid(oid, tId, null); confirmAndCredit(oid, PADMIN); };

  // 已完成 + 开票中(待开票)
  oReq = createOrder({ tenantId: tId, userId: adminU, planId: plan('P-req', 100) }).id; credit(oReq);
  requestInvoice({ orderIds: [oReq], tenantId: tId, userId: adminU, title: '抬头A', taxNo: 'T1' });
  // 已完成 + 已开票
  oIssued = createOrder({ tenantId: tId, userId: adminU, planId: plan('P-iss', 200) }).id; credit(oIssued);
  const invI = requestInvoice({ orderIds: [oIssued], tenantId: tId, userId: adminU, title: '抬头B', taxNo: 'T2' });
  issueInvoice(invI.id, 'INV-001', 'invoices/x.pdf');
  // 已完成 + 未开票
  oNoInvoice = createOrder({ tenantId: tId, userId: adminU, planId: plan('P-none', 300) }).id; credit(oNoInvoice);
  // 待确认
  oPaid = createOrder({ tenantId: tId, userId: adminU, planId: plan('P-paid', 400) }).id; claimPaid(oPaid, tId, null);
  // 待支付
  oPending = createOrder({ tenantId: tId, userId: adminU, planId: plan('P-pend', 500) }).id;
  // 已驳回
  oRejected = createOrder({ tenantId: tId, userId: adminU, planId: plan('P-rej', 600) }).id;
  claimPaid(oRejected, tId, null); rejectOrder(oRejected, PADMIN, '对不上账');
  // 已取消
  oCancelled = createOrder({ tenantId: tId, userId: adminU, planId: plan('P-can', 700) }).id;
  cancelOrder(oCancelled, tId);
  // 合并发票:两单一票(都已完成 → 开票中)
  oMergeA = createOrder({ tenantId: tId, userId: adminU, planId: plan('P-mA', 800) }).id; credit(oMergeA);
  oMergeB = createOrder({ tenantId: tId, userId: adminU, planId: plan('P-mB', 900) }).id; credit(oMergeB);
  requestInvoice({ orderIds: [oMergeA, oMergeB], tenantId: tId, userId: adminU, title: '合并', taxNo: 'T3' });
});

// 仅看本租户的行(库跨文件共享,排除其它测试订单)。
const mine = (rows: ReturnType<typeof listOrdersForAdmin>) => rows.filter((o) => o.tenant_id === tId);

describe('listOrdersForAdmin', () => {
  it('view=todo = 待确认 ∪ (已完成且开票中)', () => {
    const ids = new Set(mine(listOrdersForAdmin({ view: 'todo' })).map((o) => o.id));
    expect(ids).toEqual(new Set([oPaid, oReq, oMergeA, oMergeB])); // 待确认1 + 开票中3
    expect(ids.has(oIssued)).toBe(false); // 已开票不在待办
    expect(ids.has(oNoInvoice)).toBe(false); // 已完成但未申请开票,不在待办
  });
  it('view=credited 带出 invoiceStatus/tenantName', () => {
    const rows = mine(listOrdersForAdmin({ view: 'credited' }));
    expect(rows.length).toBe(5); // oReq,oIssued,oNoInvoice,oMergeA,oMergeB
    const req = rows.find((o) => o.id === oReq)!;
    expect(req.invoiceStatus).toBe('requested');
    expect(req.tenantName).toBe('订单管理台');
    expect(rows.find((o) => o.id === oIssued)!.invoiceStatus).toBe('issued');
    expect(rows.find((o) => o.id === oNoInvoice)!.invoiceStatus).toBeNull();
  });
  it('发票子筛选 issued / none / requested', () => {
    expect(mine(listOrdersForAdmin({ view: 'all', invoice: 'issued' })).map((o) => o.id)).toEqual([oIssued]);
    expect(mine(listOrdersForAdmin({ view: 'all', invoice: 'none' })).map((o) => o.id)).toEqual([oNoInvoice]);
    expect(new Set(mine(listOrdersForAdmin({ view: 'all', invoice: 'requested' })).map((o) => o.id)))
      .toEqual(new Set([oReq, oMergeA, oMergeB]));
  });
});

describe('adminOrderCounts(增量,排除跨文件干扰)', () => {
  it('计数正确', () => {
    const c = adminOrderCounts();
    expect(c.byStatus.pending_payment - base.byStatus.pending_payment).toBe(1);
    expect(c.byStatus.paid_claimed - base.byStatus.paid_claimed).toBe(1);
    expect(c.byStatus.credited - base.byStatus.credited).toBe(5);
    expect(c.byStatus.rejected - base.byStatus.rejected).toBe(1);
    expect(c.byStatus.cancelled - base.byStatus.cancelled).toBe(1);
    expect(c.all - base.all).toBe(9);
    expect(c.todo - base.todo).toBe(4);
    expect(c.byInvoice.none - base.byInvoice.none).toBe(1);
    expect(c.byInvoice.requested - base.byInvoice.requested).toBe(3);
    expect(c.byInvoice.issued - base.byInvoice.issued).toBe(1);
  });
});

describe('搜索 + 分页(countOrdersForAdmin / q / limit·offset)', () => {
  it('count 与 list 同口径', () => {
    expect(countOrdersForAdmin({ view: 'all', q: '订单管理台' })).toBe(9);
    expect(countOrdersForAdmin({ view: 'credited', q: '订单管理台' })).toBe(5);
  });
  it('q 按租户名 / 订单号 模糊匹配', () => {
    expect(mine(listOrdersForAdmin({ view: 'all', q: '订单管理台', limit: 50 })).length).toBe(9);
    const no = listOrdersForAdmin({ view: 'all', q: '订单管理台', limit: 1 })[0]!.order_no;
    const hit = listOrdersForAdmin({ view: 'all', q: no, limit: 50 });
    expect(hit.length).toBe(1);
    expect(hit[0]!.order_no).toBe(no);
  });
  it('q 无匹配 → 空', () => {
    expect(listOrdersForAdmin({ view: 'all', q: '不存在的租户XYZ', limit: 50 }).length).toBe(0);
    expect(countOrdersForAdmin({ view: 'all', q: '不存在的租户XYZ' })).toBe(0);
  });
  it('limit / offset 分页', () => {
    const page1 = listOrdersForAdmin({ view: 'all', q: '订单管理台', limit: 4, offset: 0 });
    const page2 = listOrdersForAdmin({ view: 'all', q: '订单管理台', limit: 4, offset: 4 });
    expect(page1.length).toBe(4);
    expect(page2.length).toBe(4);
    expect(new Set([...page1, ...page2].map((o) => o.id)).size).toBe(8); // 无重叠
  });
});

describe('getOrderDetailForAdmin', () => {
  it('合并发票 → 带出兄弟单(含 isSelf 标记)', () => {
    const d = getOrderDetailForAdmin(oMergeA)!;
    expect(d.invoice?.status).toBe('requested');
    expect(d.invoice?.orderIds?.length).toBe(2); // 模型返回 InvoiceRow(含 orderIds);orderCount 由路由派生
    expect(d.siblingOrders.length).toBe(2);
    expect(d.siblingOrders.find((s) => s.isSelf)?.orderNo).toBeTruthy();
  });
  it('无发票订单 → invoice=null,无兄弟单', () => {
    const d = getOrderDetailForAdmin(oNoInvoice)!;
    expect(d.invoice).toBeNull();
    expect(d.siblingOrders).toEqual([]);
  });
  it('不存在 → null', () => {
    expect(getOrderDetailForAdmin('nope')).toBeNull();
  });
});

describe('发票号选填(issueInvoice 允许 null)', () => {
  it('不填发票号 → 已开票,invoice_no=null', () => {
    const pid = createPlan({ name: '选填票', priceYuan: 333, credits: 3330 }).id;
    const oid = createOrder({ tenantId: tId, userId: adminU, planId: pid }).id;
    claimPaid(oid, tId, null); confirmAndCredit(oid, PADMIN);
    const inv = requestInvoice({ orderIds: [oid], tenantId: tId, userId: adminU, title: '选填', taxNo: 'TX' });
    expect(issueInvoice(inv.id, null, 'invoices/y.pdf')).toBe(true);
    const d = getOrderDetailForAdmin(oid)!;
    expect(d.invoice?.status).toBe('issued');
    expect(d.invoice?.invoice_no).toBeNull();
  });
});

// 放最后:会取消 oPending,不影响前面的断言。
describe('cancelStalePendingOrders(待支付超时自动取消)', () => {
  const isPending = (id: string) => listOrdersForAdmin({ view: 'pending_payment', limit: 99 }).some((o) => o.id === id);
  it('未超时不取消', () => {
    expect(cancelStalePendingOrders(60 * 60 * 1000)).toBe(0); // 1h 窗口,刚建的单不动
    expect(isPending(oPending)).toBe(true);
  });
  it('超时 → 取消(仅 pending_payment;待确认不动)', () => {
    expect(isPending(oPending)).toBe(true);
    const n = cancelStalePendingOrders(-1); // 窗口 -1ms = 全部待支付视为超时
    expect(n).toBeGreaterThanOrEqual(1);
    expect(isPending(oPending)).toBe(false);
    expect(listOrdersForAdmin({ view: 'cancelled', limit: 99 }).some((o) => o.id === oPending)).toBe(true);
    expect(listOrdersForAdmin({ view: 'paid_claimed', limit: 99 }).some((o) => o.id === oPaid)).toBe(true); // 待确认未被误伤
  });
});
