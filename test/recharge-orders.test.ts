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
});

describe('建单 + 快照 + 守卫', () => {
  it('正常下单:全快照落库 + order_no 格式', () => {
    const o = createOrder({ tenantId: tId, userId: alice, planId });
    expect(o.status).toBe('pending_payment');
    expect(o.plan_name).toBe('专业版');
    expect(o.price_yuan).toBe(5000);
    expect(o.credits).toBe(50000);
    expect(o.bonus_credits).toBe(5000);
    expect(o.order_no).toMatch(/^LJ\d{8}-\d{4}$/);
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

  it('order_no 当日递增且唯一(外部 #1)', () => {
    const a = createOrder({ tenantId: tId, userId: alice, planId });
    const b = createOrder({ tenantId: tId, userId: alice, planId });
    expect(a.order_no).not.toBe(b.order_no);
    const seqA = Number(a.order_no.split('-')[1]);
    const seqB = Number(b.order_no.split('-')[1]);
    expect(seqB).toBe(seqA + 1);
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
  it('驳回 → rejected + 备注;用户重提 → paid_claimed', () => {
    const o = createOrder({ tenantId: tId, userId: alice, planId });
    claimPaid(o.id, tId, null);
    expect(rejectOrder(o.id, admin, '未查到到账')).toBe(true);
    const r = getOrderForActor(o.id, tId, alice, false)!;
    expect(r.status).toBe('rejected');
    expect(r.admin_note).toBe('未查到到账');
    // 重提
    expect(claimPaid(o.id, tId, 'receipt-key-1')).toBe(true);
    expect(getOrderForActor(o.id, tId, alice, false)!.status).toBe('paid_claimed');
  });

  it('取消仅 pending/rejected;paid_claimed 取消 → false(守卫兑底,外部 #3)', () => {
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

describe('发票闭环', () => {
  it('仅 credited 订单可申请;非 credited → 拒', () => {
    const o = createOrder({ tenantId: tId, userId: alice, planId });
    expect(() =>
      requestInvoice({ orderId: o.id, tenantId: tId, userId: alice, title: '某公司', taxNo: '123' }),
    ).toThrow(); // pending → 拒
    claimPaid(o.id, tId, null);
    confirmAndCredit(o.id, admin); // → credited
    const inv = requestInvoice({
      orderId: o.id,
      tenantId: tId,
      userId: alice,
      title: '某公司',
      taxNo: '91320114MA',
    });
    expect(inv.status).toBe('requested');
    expect(inv.amount_yuan).toBe(5000); // 金额取订单快照
  });

  it('重复申请 → 拒;超管回填 → issued + 用户可下载', () => {
    const o = createOrder({ tenantId: tId, userId: bob, planId });
    claimPaid(o.id, tId, null);
    confirmAndCredit(o.id, admin);
    const inv = requestInvoice({
      orderId: o.id,
      tenantId: tId,
      userId: bob,
      title: 'B公司',
      taxNo: 'TAX',
    });
    expect(() =>
      requestInvoice({ orderId: o.id, tenantId: tId, userId: bob, title: 'B公司', taxNo: 'TAX' }),
    ).toThrow(); // 重复
    expect(issueInvoice(inv.id, 'INV-001', 'pdf-key-1')).toBe(true);
    const got = getInvoiceForActor(inv.id, tId, bob, false)!;
    expect(got.status).toBe('issued');
    expect(got.invoice_no).toBe('INV-001');
    // 隔离:alice 取不到 bob 的发票
    expect(getInvoiceForActor(inv.id, tId, alice, false)).toBeUndefined();
  });

  it('alice 不能给 bob 的订单开票(归属校验)', () => {
    const ob = createOrder({ tenantId: tId, userId: bob, planId });
    claimPaid(ob.id, tId, null);
    confirmAndCredit(ob.id, admin);
    expect(() =>
      requestInvoice({ orderId: ob.id, tenantId: tId, userId: alice, title: 'x', taxNo: 'y' }),
    ).toThrow();
  });
});
