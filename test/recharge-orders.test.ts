// 灵镜 对公充值闭环 — 订单 + 发票状态机 + 确认到账(钱路回归)。
//
// 覆盖(eng-review + 外部声音定稿):
//   - 钱路:双调 confirmAndCredit「只 grant 一次」(并发后来者 changes=0);grant=credits+bonus 全额
//   - 状态机:claimPaid/reject/resubmit/cancel 合法迁移 + 非法迁移被守卫拦
//   - 建单:全快照落库;拒 price_yuan=NULL(面议)/未 enabled 套餐
//   - order_no:唯一、当日递增
//   - 账号隔离:creator 只看自己订单/发票;IDOR 拿别人 id → undefined
//   - 发票:仅 credited 订单可申请;重复申请拒;超管回填 issued
//   - ledger 幂等:order_id 部分唯一索引兜底(逻辑外二次 grant 同 order → 抛)

import { describe, it, expect, beforeAll } from 'vitest';

process.env.DB_FILE = ':memory:';

const { db } = await import('../src/db/index.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { createPlan } = await import('../src/pricing/index.js');
const { balance, grant } = await import('../src/credits/index.js');
const {
  createOrder,
  getOrderForActor,
  listOrdersForActor,
  claimPaid,
  cancelOrder,
  rejectOrder,
  confirmAndCredit,
  requestInvoice,
  getInvoiceForActor,
  listInvoicesForActor,
  issueInvoice,
  rejectInvoice,
  setPayee,
  OrderError,
} = await import('../src/orders/index.js');

let tId = '';
let alice = ''; // creator A
let bob = ''; // creator B
let admin = '';
let planId = '';
let pricedFaceId = ''; // 面议套餐(price_yuan=null)
let disabledId = '';

beforeAll(() => {
  tId = createTenant('充值测试台').id;
  admin = createUser(tId, 'rcadmin', 'pw123456', 'admin').id;
  alice = createUser(tId, 'rcalice', 'pw123456', 'creator').id;
  bob = createUser(tId, 'rcbob', 'pw123456', 'creator').id;
  planId = createPlan({ name: '专业版', priceYuan: 5000, credits: 50000, bonusCredits: 5000 }).id;
  pricedFaceId = createPlan({ name: '企业版', priceYuan: null, credits: 100000 }).id; // 面议
  disabledId = createPlan({
    name: '下架版',
    priceYuan: 100,
    credits: 1000,
    enabled: false,
  }).id;
  // payee 已配(createOrder 守卫前置;未配会拒下单)
  setPayee({ payeeName: '测试公司', taxNo: 'TAX', bankName: '测试行', bankAccount: '6222000000' });
});

describe('建单 + 快照 + 守卫', () => {
  it('正常下单:全快照落库 + order_no 格式 + payment_method 默认 offline_bank', () => {
    const o = createOrder({ tenantId: tId, userId: alice, planId });
    expect(o.status).toBe('pending_payment');
    expect(o.plan_name).toBe('专业版');
    expect(o.price_yuan).toBe(5000);
    expect(o.credits).toBe(50000);
    expect(o.bonus_credits).toBe(5000);
    expect(o.order_no).toMatch(/^LJ\d{8}-\d{4}$/);
    expect(o.payment_method).toBe('offline_bank'); // 本轮唯一方式,为未来预留
  });

  it('复用未付单:同 (user, plan) 已有 pending → 返现有,不新建(外部 #1/#2 防孤儿+双击)', () => {
    const a = createOrder({ tenantId: tId, userId: bob, planId });
    const b = createOrder({ tenantId: tId, userId: bob, planId }); // 同套餐再下 → 返同一单
    expect(b.id).toBe(a.id);
    expect(b.order_no).toBe(a.order_no);
    // bob 只有一条 pending 单(没堆积)
    const pendings = listOrdersForActor(tId, bob, false).filter((o) => o.status === 'pending_payment');
    expect(pendings.length).toBe(1);
  });

  it('payee 未配 → 拒下单(外部 #7,不生成付不了的孤儿单)', () => {
    const t2 = createTenant('未配台').id;
    const u2 = createUser(t2, 'noConfig', 'pw123456', 'creator').id;
    const p2 = createPlan({ name: '台2套餐', priceYuan: 100, credits: 1000 }).id;
    // 注:payee 是单例全局配置,这里已被 beforeAll 配上 → 改成临时清空验证守卫逻辑
    setPayee({ payeeName: '', taxNo: '', bankName: '', bankAccount: '' });
    expect(() => createOrder({ tenantId: t2, userId: u2, planId: p2 })).toThrow(/对公收款/);
    // 恢复,不影响后续用例
    setPayee({ payeeName: '测试公司', taxNo: 'TAX', bankName: '测试行', bankAccount: '6222000000' });
  });

  it('面议套餐(price_yuan=null)→ 拒(外部 #5)', () => {
    expect(() => createOrder({ tenantId: tId, userId: alice, planId: pricedFaceId })).toThrow(
      OrderError,
    );
  });

  it('未 enabled 套餐 → 拒', () => {
    expect(() => createOrder({ tenantId: tId, userId: alice, planId: disabledId })).toThrow();
  });

  it('不存在套餐 → 拒', () => {
    expect(() => createOrder({ tenantId: tId, userId: alice, planId: 'nope' })).toThrow();
  });

  it('order_no 当日递增且唯一(不同套餐 → 不同单)', () => {
    // 用不同套餐绕开「复用未付单」(同套餐会返现有);两单 order_no 递增唯一。
    const plan2 = createPlan({ name: '套餐2', priceYuan: 200, credits: 2000 }).id;
    const a = createOrder({ tenantId: tId, userId: alice, planId });
    const b = createOrder({ tenantId: tId, userId: alice, planId: plan2 });
    expect(a.order_no).not.toBe(b.order_no); // 唯一
    const seqA = Number(a.order_no.split('-')[1]);
    const seqB = Number(b.order_no.split('-')[1]);
    expect(seqB).toBeGreaterThan(seqA); // 递增(中间可能有其他用例下的单,不强求 +1)
  });
});

describe('★钱路★ 确认到账只 grant 一次', () => {
  it('双调 confirmAndCredit → 只一条 grant,余额只涨一次(并发等价)', () => {
    const before = balance(tId);
    const o = createOrder({ tenantId: tId, userId: alice, planId });
    expect(claimPaid(o.id, tId, null)).toBe(true);

    const first = confirmAndCredit(o.id, admin);
    const second = confirmAndCredit(o.id, admin); // 后来者:status 已 credited → changes=0
    expect(first).toBe(true);
    expect(second).toBe(false); // 不重发

    // 余额只涨 credits+bonus 一次
    expect(balance(tId) - before).toBe(50000 + 5000);
    // ledger 只一条该 order 的 grant
    const rows = db
      .prepare(`SELECT COUNT(*) AS n FROM credit_ledger WHERE order_id=? AND kind='grant'`)
      .get(o.id) as { n: number };
    expect(rows.n).toBe(1);
  });

  it('grant 金额 = credits + bonus 全额', () => {
    const before = balance(tId);
    const o = createOrder({ tenantId: tId, userId: bob, planId });
    claimPaid(o.id, tId, null);
    confirmAndCredit(o.id, admin);
    expect(balance(tId) - before).toBe(55000);
  });

  it('ledger 部分唯一索引兜底:逻辑外对同 order 二次 grant → 抛(外部 #8)', () => {
    const o = createOrder({ tenantId: tId, userId: alice, planId });
    claimPaid(o.id, tId, null);
    confirmAndCredit(o.id, admin); // 第一次正常
    // 模拟逻辑漏判,直接再 grant 同 order → UNIQUE(order_id) WHERE kind='grant' 拦
    expect(() => grant(tId, 1000, '重复', o.id)).toThrow();
  });

  it('未到 paid_claimed 不能确认(pending 直接 confirm → false)', () => {
    const o = createOrder({ tenantId: tId, userId: alice, planId });
    expect(confirmAndCredit(o.id, admin)).toBe(false); // 还在 pending_payment
    expect(getOrderForActor(o.id, tId, alice, false)!.status).toBe('pending_payment');
  });
});

describe('状态机:驳回 / 重提 / 取消', () => {
  it('驳回 → rejected 终态:不可重提、不可取消(用户决策:驳回无需重新支付)', () => {
    const o = createOrder({ tenantId: tId, userId: alice, planId });
    claimPaid(o.id, tId, null);
    expect(rejectOrder(o.id, admin, '未查到到账')).toBe(true);
    const r = getOrderForActor(o.id, tId, alice, false)!;
    expect(r.status).toBe('rejected');
    expect(r.admin_note).toBe('未查到到账');
    // 终态:重提无效(驳回不可逆),取消也无效
    expect(claimPaid(o.id, tId, 'receipt-key-1')).toBe(false);
    expect(cancelOrder(o.id, tId)).toBe(false);
    expect(getOrderForActor(o.id, tId, alice, false)!.status).toBe('rejected'); // 仍是 rejected
  });

  it('取消仅 pending_payment;paid_claimed 取消 → false(守卫兑底)', () => {
    const o = createOrder({ tenantId: tId, userId: alice, planId });
    claimPaid(o.id, tId, null); // → paid_claimed
    expect(cancelOrder(o.id, tId)).toBe(false); // 守卫拦
    expect(getOrderForActor(o.id, tId, alice, false)!.status).toBe('paid_claimed');
  });

  it('cancelled / credited 后驳回无效(非法迁移被守卫拦)', () => {
    const o = createOrder({ tenantId: tId, userId: alice, planId });
    expect(cancelOrder(o.id, tId)).toBe(true); // pending → cancelled
    expect(rejectOrder(o.id, admin, 'x')).toBe(false); // 非 paid_claimed
  });
});

describe('账号隔离 + IDOR', () => {
  it('creator 只看自己订单;admin 看全机构', () => {
    const oa = createOrder({ tenantId: tId, userId: alice, planId });
    const ob = createOrder({ tenantId: tId, userId: bob, planId });
    const aList = listOrdersForActor(tId, alice, false).map((o) => o.id);
    expect(aList).toContain(oa.id);
    expect(aList).not.toContain(ob.id);
    const adminList = listOrdersForActor(tId, admin, true).map((o) => o.id);
    expect(adminList).toContain(oa.id);
    expect(adminList).toContain(ob.id);
  });

  it('IDOR:alice 拿 bob 的 orderId → 取不到(404 基础)', () => {
    const ob = createOrder({ tenantId: tId, userId: bob, planId });
    expect(getOrderForActor(ob.id, tId, alice, false)).toBeUndefined();
    expect(getOrderForActor(ob.id, tId, bob, false)).toBeTruthy();
    expect(getOrderForActor(ob.id, tId, admin, true)).toBeTruthy(); // admin 可取
  });
});

describe('发票一票多单', () => {
  // 造一个 credited 订单返回(planId=5000/55000)。
  function creditedOrder(userId: string): string {
    const o = createOrder({ tenantId: tId, userId, planId });
    claimPaid(o.id, tId, null);
    confirmAndCredit(o.id, admin);
    return o.id;
  }

  it('多单合开:Σ金额累加 + 状态 requested + orderIds 全含', () => {
    const o1 = creditedOrder(alice);
    const o2 = creditedOrder(bob); // admin 可批别人(alice/bob)的单
    const inv = requestInvoice({
      orderIds: [o1, o2],
      tenantId: tId,
      userId: admin,
      title: '合开公司',
      taxNo: '91320114MA',
    });
    expect(inv.status).toBe('requested');
    expect(inv.amount_yuan).toBe(10000); // 5000 + 5000
    expect(inv.orderIds!.sort()).toEqual([o1, o2].sort());
  });

  it('含非 credited 订单 → 拒(钱路校验)', () => {
    const credited = creditedOrder(alice);
    const pending = createOrder({ tenantId: tId, userId: alice, planId }).id; // pending 单 id
    expect(() =>
      requestInvoice({ orderIds: [credited, pending], tenantId: tId, userId: admin, title: 'x', taxNo: 'y' }),
    ).toThrow(/已到账|不存在/);
  });

  it('空选 → 拒(外部 #7)', () => {
    expect(() =>
      requestInvoice({ orderIds: [], tenantId: tId, userId: admin, title: 'x', taxNo: 'y' }),
    ).toThrow(/至少选择/);
  });

  it('UNIQUE 防重开:已在发票里的订单不能再开(外部 #6)', () => {
    const o = creditedOrder(alice);
    requestInvoice({ orderIds: [o], tenantId: tId, userId: admin, title: 'A', taxNo: 'T' });
    expect(() =>
      requestInvoice({ orderIds: [o], tenantId: tId, userId: admin, title: 'B', taxNo: 'T' }),
    ).toThrow(/已申请|已开票|占用/);
  });

  it('订单开票状态派生:未开→requested→issued(列表徽章用)', () => {
    const o = creditedOrder(alice);
    // 未开票:invoiceStatus 空
    let row = listOrdersForActor(tId, admin, true).find((r) => r.id === o);
    expect(row!.invoiceStatus ?? null).toBeNull();
    // 申请 → 开票中
    const inv = requestInvoice({ orderIds: [o], tenantId: tId, userId: admin, title: 'A', taxNo: 'T' });
    row = listOrdersForActor(tId, admin, true).find((r) => r.id === o);
    expect(row!.invoiceStatus).toBe('requested');
    // 开具 → 已开
    issueInvoice(inv.id, 'INV-X', null);
    row = listOrdersForActor(tId, admin, true).find((r) => r.id === o);
    expect(row!.invoiceStatus).toBe('issued');
  });

  it('开具重校 + 驳回释放订单回未开票(架构 #1)', () => {
    const o1 = creditedOrder(alice);
    const o2 = creditedOrder(bob);
    const inv = requestInvoice({ orderIds: [o1, o2], tenantId: tId, userId: admin, title: 'A', taxNo: 'T' });
    // 开具(重校 Σ金额=发票金额)
    expect(issueInvoice(inv.id, 'INV-001', 'pdf-1')).toBe(true);
    const got = getInvoiceForActor(inv.id, tId, admin, true)!;
    expect(got.status).toBe('issued');
    expect(got.invoice_no).toBe('INV-001');

    // 另起一张可驳回的(requested)→ 驳回后订单释放
    const o3 = creditedOrder(alice);
    const inv2 = requestInvoice({ orderIds: [o3], tenantId: tId, userId: admin, title: 'B', taxNo: 'T' });
    expect(rejectInvoice(inv2.id)).toBe(true);
    // o3 释放回未开票,可重新开
    const row = listOrdersForActor(tId, admin, true).find((r) => r.id === o3);
    expect(row!.invoiceStatus ?? null).toBeNull();
    expect(() =>
      requestInvoice({ orderIds: [o3], tenantId: tId, userId: admin, title: 'B2', taxNo: 'T' }),
    ).not.toThrow();
  });

  it('发票租户级可见:creator 也能查看本机构发票(只读)', () => {
    const o = creditedOrder(alice);
    const inv = requestInvoice({ orderIds: [o], tenantId: tId, userId: admin, title: 'A', taxNo: 'T' });
    // creator alice 能取到(发票是机构级,非按 created_by 隔离)
    expect(getInvoiceForActor(inv.id, tId, alice, false)).toBeTruthy();
    expect(listInvoicesForActor(tId, alice, false).some((x) => x.id === inv.id)).toBe(true);
  });
});
