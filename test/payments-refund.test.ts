// 灵镜 在线支付 — 退款闭环(决策5/10/11/16/21/28)+ ledger 口径回归。
//
// 覆盖:整单退款(支付宝同步/微信异步)、挂票拒退、通道失败回退不卡死、退款幂等
//   (唯一索引双保险)、attempt-only 退款不追 ledger、负余额 reserve 失败、
//   usageSummary 排除 refund(消耗统计回归铁律)。

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

process.env.DB_FILE = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://pay-test.example.com';

const { db } = await import('../src/db/index.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { createPlan } = await import('../src/pricing/index.js');
const { balance, usageSummary, reserve, refundClawback, grant } = await import('../src/credits/index.js');
const {
  createOrder, getOrder, setPayee, startPayment, applyPaymentSuccess,
  startRefund, startRefundForAttempt, applyRefundResult, getAttempt,
  cancelOrderWithAttempt, requestInvoice, rejectInvoice, OrderError,
} = await import('../src/orders/index.js');
const { setProviderForTest, saveChannelSetting } = await import('../src/payments/index.js');

let tId = '', admin = '', padmin = 'padmin-1';
let refundBehavior: { status: 'succeeded' } | { status: 'processing' } | { status: 'failed'; reason: string };
const refundCalls: unknown[] = [];

beforeAll(async () => {
  tId = createTenant('退款测试台').id;
  admin = (await createUser(tId, 'rfadmin', 'pw123456', 'admin')).id;
  setPayee({ payeeName: '公司', taxNo: 'T', bankName: '行', bankAccount: '622' });
  saveChannelSetting('wechat', { enabledScenes: ['native'], config: {} });
});

let wxProvider: any;
beforeEach(() => {
  refundBehavior = { status: 'succeeded' };
  refundCalls.length = 0;
  wxProvider = {
    channel: 'wechat',
    async createPayment(i: any) { return { kind: 'qr', payload: `pay://${i.attemptId}` }; },
    async queryPayment() { return { status: 'pending' }; },
    async verifyNotify() { throw new Error('unused'); },
    async closePayment() {},
    async refund(i: any) { refundCalls.push(i); return refundBehavior; },
    async downloadBill() { return []; },
  };
  setProviderForTest('wechat', wxProvider as never);
});

let seq = 0;
async function creditedOnlineOrder() {
  const planId = createPlan({ name: `退款版#${++seq}`, priceYuan: 100, credits: 1000, bonusCredits: 100 }).id;
  const o = createOrder({ tenantId: tId, userId: admin, planId });
  const r = await startPayment({ orderId: o.id, tenantId: tId, channel: 'wechat', scene: 'native', clientIp: '' });
  const attemptId = (r as any).attemptId as string;
  expect(applyPaymentSuccess('wechat', attemptId, `txn_${seq}`, 10000)).toBe('credited');
  return { orderId: o.id, attemptId };
}

describe('整单退款闭环', () => {
  it('同步成功(支付宝形态):credited→refunded,ledger 追回,余额扣减', async () => {
    const { orderId, attemptId } = await creditedOnlineOrder();
    const before = balance(tId);
    const outcome = await startRefund(orderId, padmin, '客户申请退款');
    expect(outcome).toBe('refunded');
    expect(getOrder(orderId)!.status).toBe('refunded');
    expect(getAttempt(attemptId)!.status).toBe('refunded');
    expect(balance(tId)).toBe(before - 1100); // credits+bonus 全额追回
    const call = refundCalls[0] as any;
    expect(call.amountFen).toBe(10000);
    expect(call.refundNo).toMatch(/^RF/);
  });
  it('异步受理(微信形态):refunding 挂起 → 退款通知确认后落账', async () => {
    const { orderId, attemptId } = await creditedOnlineOrder();
    refundBehavior = { status: 'processing' };
    const outcome = await startRefund(orderId, padmin, '客户申请');
    expect(outcome).toBe('refunding');
    expect(getOrder(orderId)!.status).toBe('refunding');
    const before = balance(tId);
    expect(applyRefundResult(attemptId, true)).toBe('refunded');
    expect(getOrder(orderId)!.status).toBe('refunded');
    expect(balance(tId)).toBe(before - 1100);
    // 重复退款通知 → duplicate,不再追回(幂等)
    expect(applyRefundResult(attemptId, true)).toBe('duplicate');
    expect(balance(tId)).toBe(before - 1100);
  });
  it('通道失败:订单回退 credited 不卡死,attempt 记原因可重试(决策21)', async () => {
    const { orderId, attemptId } = await creditedOnlineOrder();
    refundBehavior = { status: 'failed', reason: '商户余额不足' };
    const before = balance(tId);
    const outcome = await startRefund(orderId, padmin, '客户申请');
    expect(outcome).toBe('failed');
    expect(getOrder(orderId)!.status).toBe('credited'); // 回退
    expect(getAttempt(attemptId)!.status).toBe('refund_failed');
    expect(getAttempt(attemptId)!.fail_reason).toContain('余额不足');
    expect(balance(tId)).toBe(before); // 未追回
    // 重试成功:同 refundNo 复用(通道侧幂等)
    refundBehavior = { status: 'succeeded' };
    expect(await startRefund(orderId, padmin, '重试')).toBe('refunded');
    expect((refundCalls[0] as any).refundNo).toBe((refundCalls[1] as any).refundNo);
  });
  it('挂票拒退(决策5):驳回发票后可退', async () => {
    const { orderId } = await creditedOnlineOrder();
    const inv = requestInvoice({ orderIds: [orderId], tenantId: tId, userId: admin, title: '抬头', taxNo: 'TAX1' });
    await expect(startRefund(orderId, padmin, 'x')).rejects.toMatchObject({ code: 'INVOICE_ATTACHED' });
    expect(getOrder(orderId)!.status).toBe('credited'); // 拦截时订单未动
    rejectInvoice(inv.id);
    expect(await startRefund(orderId, padmin, '驳票后退')).toBe('refunded');
  });
  it('对公单(无在线流水)不能原路退款', async () => {
    const planId = createPlan({ name: `对公版#${++seq}`, priceYuan: 100, credits: 1000 }).id;
    const o = createOrder({ tenantId: tId, userId: admin, planId });
    await expect(startRefund(o.id, padmin, 'x')).rejects.toMatchObject({ code: 'NO_ONLINE_PAYMENT' });
  });
  it('退款在途重复发起 → REFUND_IN_FLIGHT', async () => {
    const { orderId } = await creditedOnlineOrder();
    refundBehavior = { status: 'processing' };
    await startRefund(orderId, padmin, 'x');
    await expect(startRefund(orderId, padmin, '再来')).rejects.toThrow(OrderError);
  });
  it('ledger 幂等双保险:守卫外强行二次 refund 写入被唯一索引拦', async () => {
    const { orderId } = await creditedOnlineOrder();
    await startRefund(orderId, padmin, 'x');
    expect(() => refundClawback(tId, 1100, '恶意二次追回', orderId)).toThrow(); // UNIQUE(order_id) WHERE kind='refund'
  });
});

describe('attempt-only 退款(迟到收款差异单,决策11)', () => {
  it('★守卫★ 已给订单入账的流水禁止走 attempt 退款(否则退钱不扣积分 → 租户白拿)', async () => {
    const { orderId, attemptId } = await creditedOnlineOrder();
    const before = balance(tId);
    await expect(startRefundForAttempt(attemptId, '误操作')).rejects.toMatchObject({
      code: 'ATTEMPT_CREDITED_ORDER',
    });
    expect(getOrder(orderId)!.status).toBe('credited'); // 订单未动
    expect(getAttempt(attemptId)!.status).toBe('paid'); // 流水未动
    expect(balance(tId)).toBe(before); // 积分未动
    expect(refundCalls).toHaveLength(0); // 通道未被调用(钱没退)
  });

  it('已取消订单的迟到收款:退通道不追 ledger(从未 grant 过)', async () => {
    const planId = createPlan({ name: `迟到版#${++seq}`, priceYuan: 100, credits: 1000 }).id;
    const o = createOrder({ tenantId: tId, userId: admin, planId });
    const r = await startPayment({ orderId: o.id, tenantId: tId, channel: 'wechat', scene: 'native', clientIp: '' });
    const attemptId = (r as any).attemptId as string;
    await cancelOrderWithAttempt(o.id, tId); // 取消(未付)
    expect(applyPaymentSuccess('wechat', attemptId, 'txn_late', 10000)).toBe('recorded_diff'); // 迟到收款
    const before = balance(tId);
    expect(await startRefundForAttempt(attemptId, '差异退回')).toBe('refunded');
    expect(getAttempt(attemptId)!.status).toBe('refunded');
    expect(getOrder(o.id)!.status).toBe('cancelled'); // 订单不动
    expect(balance(tId)).toBe(before); // 不追 ledger(决策11)
  });
});

describe('★对抗评审★ 退款结果未知 / 退错笔 / 迟到成功通知', () => {
  it('通道超时(结果未知)→ 保持 refunding 不回滚;随后真正的成功通知能落账+追回', async () => {
    const { orderId, attemptId } = await creditedOnlineOrder();
    const before = balance(tId);
    // 微信已受理退款但响应超时 → provider 抛 UPSTREAM
    wxProvider.refund = async () => { throw new (await import('../src/payments/types.js')).PaymentError('UPSTREAM', '微信退款结果未知(504)'); };
    const outcome = await startRefund(orderId, padmin, '客户申请');
    expect(outcome).toBe('refunding');
    expect(getOrder(orderId)!.status).toBe('refunding'); // ★不回滚成 credited★(否则成功通知会被吞)
    expect(getAttempt(attemptId)!.status).toBe('refunding');
    expect(balance(tId)).toBe(before); // 尚未追回
    // 真正的退款成功通知到达 → 落账 + 追回
    expect(applyRefundResult(attemptId, true)).toBe('refunded');
    expect(getOrder(orderId)!.status).toBe('refunded');
    expect(balance(tId)).toBe(before - 1100);
  });
  it('已判失败回滚后,迟到的退款成功通知仍能补追 ledger(不再静默吞掉)', async () => {
    const { orderId, attemptId } = await creditedOnlineOrder();
    refundBehavior = { status: 'failed', reason: '通道拒绝' };
    expect(await startRefund(orderId, padmin, 'x')).toBe('failed');
    expect(getOrder(orderId)!.status).toBe('credited'); // 已回滚
    expect(getAttempt(attemptId)!.status).toBe('refund_failed');
    const before = balance(tId);
    // 通道其实退成功了,通知迟到 → credited→refunded + 追回(唯一索引保恰一次)
    expect(applyRefundResult(attemptId, true)).toBe('refunded');
    expect(getOrder(orderId)!.status).toBe('refunded');
    expect(balance(tId)).toBe(before - 1100);
  });
  it('一单两笔已收款:退款退的是「入账那一笔」,不是最近一笔', async () => {
    const planId = createPlan({ name: `双收款版#${++seq}`, priceYuan: 100, credits: 1000, bonusCredits: 100 }).id;
    const o = createOrder({ tenantId: tId, userId: admin, planId });
    // A:出码 → 用户没扫 → 过期关闭
    const rA = await startPayment({ orderId: o.id, tenantId: tId, channel: 'wechat', scene: 'native', clientIp: '' });
    const aA = (rA as any).attemptId as string;
    db.prepare(`UPDATE payment_attempt SET status='expired' WHERE id=?`).run(aA);
    // B:新码 → 支付成功 → 入账
    const rB = await startPayment({ orderId: o.id, tenantId: tId, channel: 'wechat', scene: 'native', clientIp: '' });
    const aB = (rB as any).attemptId as string;
    expect(applyPaymentSuccess('wechat', aB, 'txn_B', 10000)).toBe('credited');
    // A 迟到支付(用户翻出旧码付了)→ 差异表,不入账;paid_at 更新(比 B 晚)
    expect(applyPaymentSuccess('wechat', aA, 'txn_A_late', 10000)).toBe('recorded_diff');
    expect(getAttempt(aA)!.status).toBe('paid');
    // 订单退款:必须退 B(入账那一笔),而非最近收款的 A
    refundCalls.length = 0;
    expect(await startRefund(o.id, padmin, '客户申请')).toBe('refunded');
    expect((refundCalls[0] as any).attemptId).toBe(aB);
    expect(getAttempt(aB)!.status).toBe('refunded');
    // A 是纯多收的钱,可从差异面板原路退回(守卫只挡「入账那一笔」)
    expect(await startRefundForAttempt(aA, '重复支付退回')).toBe('refunded');
  });
  it('金额不符的收款:attempt 迁出 pending(不再永久占坑饿死 sweep),可原路退回', async () => {
    const planId = createPlan({ name: `错额版#${++seq}`, priceYuan: 100, credits: 1000 }).id;
    const o = createOrder({ tenantId: tId, userId: admin, planId });
    const r = await startPayment({ orderId: o.id, tenantId: tId, channel: 'wechat', scene: 'native', clientIp: '' });
    const a = (r as any).attemptId as string;
    expect(applyPaymentSuccess('wechat', a, 'txn_bad', 9999)).toBe('recorded_diff'); // 少 1 分
    expect(getAttempt(a)!.status).toBe('paid'); // ★不再是 pending★
    expect(getOrder(o.id)!.status).toBe('pending_payment'); // 未入账
    expect(await startRefundForAttempt(a, '金额不符退回')).toBe('refunded');
  });
});

describe('退款崩溃恢复(refunding 卡死防线)', () => {
  it('本地已置 refunding 但通道从未调用(进程崩溃)→ 10 分钟后可重驱,同 refund_no 幂等', async () => {
    const { orderId, attemptId } = await creditedOnlineOrder();
    refundBehavior = { status: 'processing' };
    await startRefund(orderId, padmin, '首次');
    expect(getOrder(orderId)!.status).toBe('refunding');
    // 立刻重试 → 被守卫拦(正常在途)
    await expect(startRefund(orderId, padmin, '重复')).rejects.toMatchObject({ code: 'REFUND_IN_FLIGHT' });
    // 时钟注入:退款停滞 > 10 分钟(崩溃场景)→ 允许重驱
    db.prepare(`UPDATE payment_attempt SET updated_at=? WHERE id=?`).run(Date.now() - 11 * 60_000, attemptId);
    refundBehavior = { status: 'succeeded' };
    const before = balance(tId);
    expect(await startRefund(orderId, padmin, '重驱')).toBe('refunded');
    expect(getOrder(orderId)!.status).toBe('refunded');
    expect(balance(tId)).toBe(before - 1100); // ledger 追回照常
    expect((refundCalls[0] as any).refundNo).toBe((refundCalls[1] as any).refundNo); // 同号 → 通道幂等
  });
});

describe('ledger 口径回归(消耗统计铁律)', () => {
  it('refund 不入消耗统计:balance 降、consumed/granted 不变;负余额 reserve 拒', async () => {
    const t2 = createTenant('口径台').id;
    grant(t2, 1000, '初始发放');
    const s0 = usageSummary(t2);
    refundClawback(t2, 1400, '退款追回(超发放)', 'order-koujing-1');
    const s1 = usageSummary(t2);
    expect(s1.balance).toBe(-400); // 余额可负(决策:退款后服务自然停用)
    expect(s1.granted).toBe(s0.granted); // 发放口径不变
    expect(s1.consumed).toBe(s0.consumed); // 消耗口径不含 refund
    expect(() => reserve(t2, 'job-x', 10)).toThrow(/余额不足/); // 负余额下新任务自然被拒
  });
});
