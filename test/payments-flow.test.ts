// 灵镜 在线支付 — 钱路集成(fake provider 注入,零外呼)。
//
// 覆盖(设计蓝图测试清单):
//   - startPayment:出码/复用在途码(双击)/切换通道关旧插新/每单恰一 pending(UNIQUE)
//   - applyPaymentSuccess 幂等矩阵:同txn重投递=duplicate;金额不符/已取消/双收款→差异表不入账;
//     paid_claimed 也入账(决策22 钱到即入账);并发双回调恰一次 grant
//   - claimPaid × 在线互斥;取消订单先查单(已付→入账不可取消)
//   - sweep:过期已付→入账 / 未付→关单+expired(时钟注入:直接改 expires_at)
//   - 回调端点:fake 验签失败→通道错误应答;成功→入账;支付宝 ACK=success 文本
//   - /check-payment 主动查单 + 限流;/payment-methods 场景开关

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

process.env.DB_FILE = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://pay-test.example.com';

const { db } = await import('../src/db/index.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { createPlan } = await import('../src/pricing/index.js');
const { balance } = await import('../src/credits/index.js');
const {
  createOrder, getOrder, claimPaid, confirmAndCredit, setPayee,
  startPayment, applyPaymentSuccess, checkPaymentNow, cancelOrderWithAttempt,
  pendingAttemptForOrder, getAttempt, sweepExpiredAttempts, pollActivePendingAttempts,
  cancelStalePendingOrders, PENDING_PAYMENT_TTL_MS, startRefund, OrderError,
} = await import('../src/orders/index.js');
const { setProviderForTest, saveChannelSetting } = await import('../src/payments/index.js');
const type_mod = await import('../src/payments/types.js');
const { createApp } = await import('../src/server.js');
const { Client } = await import('./helpers.js');

type QueryResult = import('../src/payments/types.js').QueryResult;

/** 可编程 fake provider:queryResult 可设;verifyNotify 直接解析测试 JSON body。 */
function fakeProvider(channel: 'wechat' | 'alipay') {
  const calls = { create: [] as unknown[], close: [] as unknown[], query: [] as unknown[], refund: [] as unknown[] };
  const state = {
    calls,
    queryResult: { status: 'pending' } as QueryResult,
    failCreate: false,
    provider: {
      channel,
      async createPayment(input: any) {
        calls.create.push(input);
        if (state.failCreate) throw new type_mod.PaymentError('UPSTREAM', '通道超时');
        return { kind: channel === 'wechat' ? ('qr' as const) : ('redirect' as const), payload: `pay://${input.attemptId}` };
      },
      async queryPayment(id: string) {
        calls.query.push(id);
        return state.queryResult;
      },
      async verifyNotify(rawBody: Buffer) {
        let j: any = {};
        try { j = JSON.parse(rawBody.toString('utf8')); } catch { /* 伪造体 */ }
        const ok = j.sig === 'valid';
        const ackOk = channel === 'alipay'
          ? { status: 200, body: 'success', contentType: 'text/plain' }
          : { status: 200, body: '{"code":"SUCCESS"}', contentType: 'application/json' };
        const ackFail = channel === 'alipay'
          ? { status: 200, body: 'failure', contentType: 'text/plain' }
          : { status: 401, body: '{"code":"FAIL"}', contentType: 'application/json' };
        if (!ok) return { ok: false, event: 'ignored' as const, ack: ackFail };
        return {
          ok: true, event: (j.event ?? 'payment') as 'payment' | 'refund',
          outTradeNo: j.outTradeNo, txnId: j.txnId, paidAmountFen: j.amountFen,
          refundNo: j.refundNo, refundStatus: j.refundStatus, ack: ackOk,
        };
      },
      async closePayment(id: string) { calls.close.push(id); },
      async refund(input: any) { calls.refund.push(input); return { status: 'succeeded' as const }; },
      async downloadBill() { return []; },
    },
  };
  return state;
}

let tId = '', admin = '', planId = '';
let wx: ReturnType<typeof fakeProvider>;
let ali: ReturnType<typeof fakeProvider>;

beforeAll(async () => {
  tId = createTenant('在线支付台').id;
  admin = (await createUser(tId, 'payadmin', 'pw123456', 'admin')).id;
  planId = createPlan({ name: '在线版', priceYuan: 350, credits: 3500, bonusCredits: 350 }).id;
  setPayee({ payeeName: '测试公司', taxNo: 'T', bankName: '测试行', bankAccount: '622' });
  // 通道场景开关(fake provider 场景仍读配置行;密钥不需要)。
  saveChannelSetting('wechat', { enabledScenes: ['native', 'h5'], config: {} });
  saveChannelSetting('alipay', { enabledScenes: ['page', 'wap'], config: {} });
});

beforeEach(() => {
  wx = fakeProvider('wechat');
  ali = fakeProvider('alipay');
  setProviderForTest('wechat', wx.provider as never);
  setProviderForTest('alipay', ali.provider as never);
});

// createOrder 会复用同 (tenant,user,plan) 的未付单(防孤儿堆积)——测试隔离:每单独立套餐。
let planSeq = 0;
const newOrder = () =>
  createOrder({
    tenantId: tId,
    userId: admin,
    planId: createPlan({ name: `在线版#${++planSeq}`, priceYuan: 350, credits: 3500, bonusCredits: 350 }).id,
  });

describe('startPayment:出码 / 复用 / 切换 / 并发唯一', () => {
  it('微信 native 出码:attempt=32hex,金额 35000 分,expires 传通道', async () => {
    const o = newOrder();
    const r = await startPayment({ orderId: o.id, tenantId: tId, channel: 'wechat', scene: 'native', clientIp: '1.2.3.4' });
    if ('alreadyPaid' in r && r.alreadyPaid) throw new Error('unexpected');
    expect(r.kind).toBe('qr');
    expect(r.attemptId).toMatch(/^[0-9a-f]{32}$/); // 微信 out_trade_no ≤32 字符(决策18)
    const created = wx.calls.create[0] as any;
    expect(created.amountFen).toBe(35000);
    expect(created.expiresAt).toBe(r.expiresAt);
    expect(created.notifyUrl).toBe('https://pay-test.example.com/api/payments/notify/wechat');
    expect(getOrder(o.id)!.payment_method).toBe('wechat');
  });
  it('双击复用在途码:第二次不再调通道下单', async () => {
    const o = newOrder();
    const r1 = await startPayment({ orderId: o.id, tenantId: tId, channel: 'wechat', scene: 'native', clientIp: '' });
    const r2 = await startPayment({ orderId: o.id, tenantId: tId, channel: 'wechat', scene: 'native', clientIp: '' });
    expect((r1 as any).attemptId).toBe((r2 as any).attemptId);
    expect(wx.calls.create).toHaveLength(1);
  });
  it('切换通道:旧码先查单再关单,新码生效,每单恰一 pending', async () => {
    const o = newOrder();
    const r1 = await startPayment({ orderId: o.id, tenantId: tId, channel: 'wechat', scene: 'native', clientIp: '' });
    const r2 = await startPayment({ orderId: o.id, tenantId: tId, channel: 'alipay', scene: 'page', clientIp: '' });
    expect(wx.calls.query).toContain((r1 as any).attemptId); // 先查单(已付则入账)
    expect(wx.calls.close).toContain((r1 as any).attemptId); // 再关单(双收款防线)
    expect(getAttempt((r1 as any).attemptId)!.status).toBe('closed');
    expect(pendingAttemptForOrder(o.id)!.id).toBe((r2 as any).attemptId);
    expect(getOrder(o.id)!.payment_method).toBe('alipay');
  });
  it('切换时旧码已付 → 入账终止切换(alreadyPaid)', async () => {
    const o = newOrder();
    const r1 = await startPayment({ orderId: o.id, tenantId: tId, channel: 'wechat', scene: 'native', clientIp: '' });
    wx.queryResult = { status: 'paid', txnId: 'wx_t1', paidAmountFen: 35000 };
    const r2 = await startPayment({ orderId: o.id, tenantId: tId, channel: 'alipay', scene: 'page', clientIp: '' });
    expect((r2 as any).alreadyPaid).toBe(true);
    expect(getOrder(o.id)!.status).toBe('credited');
    expect(getAttempt((r1 as any).attemptId)!.status).toBe('paid');
  });
  it('通道下单失败:attempt 作废,订单无损可重试', async () => {
    const o = newOrder();
    wx.failCreate = true;
    await expect(startPayment({ orderId: o.id, tenantId: tId, channel: 'wechat', scene: 'native', clientIp: '' }))
      .rejects.toThrow('通道超时');
    expect(pendingAttemptForOrder(o.id)).toBeUndefined();
    expect(getOrder(o.id)!.status).toBe('pending_payment');
    wx.failCreate = false;
    const r = await startPayment({ orderId: o.id, tenantId: tId, channel: 'wechat', scene: 'native', clientIp: '' });
    expect((r as any).attemptId).toBeTruthy();
  });
  it('未启用场景 → CHANNEL_UNAVAILABLE', async () => {
    const o = newOrder();
    saveChannelSetting('wechat', { enabledScenes: ['native'], config: {} }); // 关 h5
    await expect(startPayment({ orderId: o.id, tenantId: tId, channel: 'wechat', scene: 'h5', clientIp: '' }))
      .rejects.toMatchObject({ code: 'CHANNEL_UNAVAILABLE' });
    saveChannelSetting('wechat', { enabledScenes: ['native', 'h5'], config: {} });
  });
});

describe('applyPaymentSuccess 幂等矩阵(决策4/22/25)', () => {
  async function paidSetup() {
    const o = newOrder();
    const r = await startPayment({ orderId: o.id, tenantId: tId, channel: 'wechat', scene: 'native', clientIp: '' });
    return { o, attemptId: (r as any).attemptId as string };
  }
  const diffCount = () => (db.prepare(`SELECT COUNT(*) n FROM recon_diff WHERE resolved=0`).get() as any).n;

  it('正常入账:恰一次 grant(credits+bonus),订单 credited,方式锁定', async () => {
    const { o, attemptId } = await paidSetup();
    const before = balance(tId);
    expect(applyPaymentSuccess('wechat', attemptId, 'wx_txn_A', 35000)).toBe('credited');
    expect(getOrder(o.id)!.status).toBe('credited');
    expect(getOrder(o.id)!.payment_method).toBe('wechat');
    expect(balance(tId)).toBe(before + 3850);
  });
  it('同交易号重复投递 → duplicate,不重复 grant', async () => {
    const { attemptId } = await paidSetup();
    applyPaymentSuccess('wechat', attemptId, 'wx_txn_B', 35000);
    const before = balance(tId);
    expect(applyPaymentSuccess('wechat', attemptId, 'wx_txn_B', 35000)).toBe('duplicate');
    expect(balance(tId)).toBe(before);
  });
  it('不同交易号命中已付 attempt = 双收款 → 差异表,不入账', async () => {
    const { attemptId } = await paidSetup();
    applyPaymentSuccess('wechat', attemptId, 'wx_txn_C1', 35000);
    const before = balance(tId); const d0 = diffCount();
    expect(applyPaymentSuccess('wechat', attemptId, 'wx_txn_C2', 35000)).toBe('recorded_diff');
    expect(balance(tId)).toBe(before);
    expect(diffCount()).toBe(d0 + 1);
  });
  it('金额差 1 分 → 差异表,不入账(134× 护栏族)', async () => {
    const { o, attemptId } = await paidSetup();
    const d0 = diffCount();
    expect(applyPaymentSuccess('wechat', attemptId, 'wx_txn_D', 34999)).toBe('recorded_diff');
    expect(getOrder(o.id)!.status).toBe('pending_payment');
    expect(diffCount()).toBe(d0 + 1);
  });
  it('未知 out_trade_no → missing_local 差异', () => {
    const d0 = diffCount();
    expect(applyPaymentSuccess('wechat', 'deadbeef'.repeat(4), 'wx_x', 100)).toBe('recorded_diff');
    expect(diffCount()).toBe(d0 + 1);
  });
  it('已取消订单迟到回调 → 差异表(超管退款闭环处理),attempt 记 paid 钱不丢', async () => {
    const { o, attemptId } = await paidSetup();
    // 取消(先关旧码)
    const c = await cancelOrderWithAttempt(o.id, tId);
    expect(c.cancelled).toBe(true);
    const d0 = diffCount();
    expect(applyPaymentSuccess('wechat', attemptId, 'wx_late', 35000)).toBe('recorded_diff');
    expect(getAttempt(attemptId)!.status).toBe('paid'); // 收款是事实,退款闭环的对象
    expect(getOrder(o.id)!.status).toBe('cancelled');
    expect(diffCount()).toBe(d0 + 1);
  });
  it('决策22:paid_claimed(对公申报后)回调到 → 照样入账,与超管 confirm 恰一次', async () => {
    // 构造:先走在线出码,再强行对公申报(绕过互斥,模拟竞态时序)
    const { o, attemptId } = await paidSetup();
    db.prepare(`UPDATE payment_attempt SET status='closed' WHERE id=?`).run(attemptId); // 使 claimPaid 互斥失效
    expect(claimPaid(o.id, tId, null)).toBe(true);
    db.prepare(`UPDATE payment_attempt SET status='pending' WHERE id=?`).run(attemptId); // 恢复在途(竞态窗口)
    const before = balance(tId);
    expect(applyPaymentSuccess('wechat', attemptId, 'wx_race', 35000)).toBe('credited');
    expect(balance(tId)).toBe(before + 3850);
    // 超管再 confirm → changes=0 不再发(恰一次)
    expect(confirmAndCredit(o.id, admin)).toBe(false);
    expect(balance(tId)).toBe(before + 3850);
  });
  it('混沌:同一入账被并发触发两路(回调+查单)→ 恰一次 grant', async () => {
    const { attemptId } = await paidSetup();
    const before = balance(tId);
    const results = [
      applyPaymentSuccess('wechat', attemptId, 'wx_cc', 35000),
      applyPaymentSuccess('wechat', attemptId, 'wx_cc', 35000),
    ];
    expect(results.filter((r) => r === 'credited')).toHaveLength(1);
    expect(results.filter((r) => r === 'duplicate')).toHaveLength(1);
    expect(balance(tId)).toBe(before + 3850);
  });
});

describe('0.01 元套餐全链(1 分钱真实联调路径)', () => {
  it('0.01 元下单 → 1 分 → 回调入账;金额差 0 分才通过', async () => {
    const planId = createPlan({ name: `一分钱#${++planSeq}`, priceYuan: 0.01, credits: 1 }).id;
    const o = createOrder({ tenantId: tId, userId: admin, planId });
    const r = await startPayment({ orderId: o.id, tenantId: tId, channel: 'wechat', scene: 'native', clientIp: '' });
    expect((wx.calls.create[0] as any).amountFen).toBe(1); // ¥0.01 = 1 分,元分换算唯一点
    expect(applyPaymentSuccess('wechat', (r as any).attemptId, 'wx_fen', 1)).toBe('credited');
    expect(getOrder(o.id)!.status).toBe('credited');
  });
});

describe('对公 × 在线互斥(决策22)', () => {
  it('有在途在线码时 claimPaid 拒(ONLINE_IN_FLIGHT)', async () => {
    const o = newOrder();
    await startPayment({ orderId: o.id, tenantId: tId, channel: 'wechat', scene: 'native', clientIp: '' });
    expect(() => claimPaid(o.id, tId, null)).toThrow(OrderError);
  });
  it('paid_claimed 后 startPayment 拒(ORDER_NOT_PAYABLE)', async () => {
    const o = newOrder();
    claimPaid(o.id, tId, null);
    await expect(startPayment({ orderId: o.id, tenantId: tId, channel: 'wechat', scene: 'native', clientIp: '' }))
      .rejects.toMatchObject({ code: 'ORDER_NOT_PAYABLE' });
  });
});

describe('sweep:过期码先查单再关单(决策13/24/27)', () => {
  it('过期未付 → 通道关单 + expired;订单可再出码', async () => {
    const o = newOrder();
    const r = await startPayment({ orderId: o.id, tenantId: tId, channel: 'wechat', scene: 'native', clientIp: '' });
    db.prepare(`UPDATE payment_attempt SET expires_at=? WHERE id=?`).run(Date.now() - 1000, (r as any).attemptId);
    await sweepExpiredAttempts();
    expect(getAttempt((r as any).attemptId)!.status).toBe('expired');
    expect(wx.calls.close).toContain((r as any).attemptId);
    expect(getOrder(o.id)!.status).toBe('pending_payment');
  });
  it('过期但已付(用户最后一秒扫码)→ 查单入账,不关单(私有化无回调时唯一入账路径)', async () => {
    const o = newOrder();
    const r = await startPayment({ orderId: o.id, tenantId: tId, channel: 'wechat', scene: 'native', clientIp: '' });
    db.prepare(`UPDATE payment_attempt SET expires_at=? WHERE id=?`).run(Date.now() - 1000, (r as any).attemptId);
    wx.queryResult = { status: 'paid', txnId: 'wx_sweep', paidAmountFen: 35000 };
    await sweepExpiredAttempts();
    expect(getOrder(o.id)!.status).toBe('credited');
    expect(wx.calls.close).not.toContain((r as any).attemptId);
  });
  it('丢回调兜底(2026-07-14 事故回归):未过期在途码被主动查单 → 已付自动入账', async () => {
    const o = newOrder();
    const r = await startPayment({ orderId: o.id, tenantId: tId, channel: 'wechat', scene: 'native', clientIp: '' });
    // 码创建 <30s 时跳过(回调大概率先到,不浪费通道调用)
    wx.queryResult = { status: 'paid', txnId: 'wx_lost_cb', paidAmountFen: 35000 };
    await pollActivePendingAttempts();
    expect(getOrder(o.id)!.status).toBe('pending_payment');
    // 时钟注入:码已创建 >30s(回调仍未到)→ 本轮查单入账,用户无需任何点击
    db.prepare(`UPDATE payment_attempt SET created_at=? WHERE id=?`).run(Date.now() - 60_000, (r as any).attemptId);
    await pollActivePendingAttempts();
    expect(getOrder(o.id)!.status).toBe('credited');
    expect(getAttempt((r as any).attemptId)!.txn_id).toBe('wx_lost_cb');
  });
  it('在途码未支付:主动查单不动它(不误关未过期码)', async () => {
    const o = newOrder();
    const r = await startPayment({ orderId: o.id, tenantId: tId, channel: 'wechat', scene: 'native', clientIp: '' });
    db.prepare(`UPDATE payment_attempt SET created_at=? WHERE id=?`).run(Date.now() - 60_000, (r as any).attemptId);
    await pollActivePendingAttempts(); // queryResult 默认 pending
    expect(getAttempt((r as any).attemptId)!.status).toBe('pending');
    expect(wx.calls.close).toHaveLength(0);
  });
  it('单单隔离:一单查单抛错不拖垮同批其他单', async () => {
    const oA = newOrder();
    const rA = await startPayment({ orderId: oA.id, tenantId: tId, channel: 'wechat', scene: 'native', clientIp: '' });
    const oB = createOrder({ tenantId: tId, userId: admin, planId: createPlan({ name: '隔离版', priceYuan: 100, credits: 1000 }).id });
    const rB = await startPayment({ orderId: oB.id, tenantId: tId, channel: 'alipay', scene: 'page', clientIp: '' });
    db.prepare(`UPDATE payment_attempt SET expires_at=? WHERE id IN (?,?)`).run(Date.now() - 1000, (rA as any).attemptId, (rB as any).attemptId);
    wx.provider.queryPayment = async () => { throw new Error('通道抖动'); };
    await sweepExpiredAttempts();
    expect(getAttempt((rA as any).attemptId)!.status).toBe('pending'); // 下轮重试
    expect(getAttempt((rB as any).attemptId)!.status).toBe('expired'); // 不受连坐
  });
});

describe('HTTP 端点:回调 / 主动查单 / 支付方式', () => {
  const app = createApp();

  async function loggedIn() {
    const c = new Client(app);
    const r = await c.login('payadmin', 'pw123456');
    expect(r.status).toBe(200);
    return c;
  }

  it('POST /api/payments/notify/wechat:验签失败→4xx;成功→入账+ACK JSON', async () => {
    const c = new Client(app);
    const o = newOrder();
    const r = await startPayment({ orderId: o.id, tenantId: tId, channel: 'wechat', scene: 'native', clientIp: '' });
    const bad = await c.post('/api/payments/notify/wechat', { sig: 'bogus' });
    expect(bad.status).toBe(401);
    const ok = await c.post('/api/payments/notify/wechat', {
      sig: 'valid', event: 'payment', outTradeNo: (r as any).attemptId, txnId: 'wx_http', amountFen: 35000,
    });
    expect(ok.status).toBe(200);
    expect(getOrder(o.id)!.status).toBe('credited');
  });
  it('支付宝回调 ACK 是字面量 success 文本(决策9)', async () => {
    const c = new Client(app);
    const o = newOrder();
    const r = await startPayment({ orderId: o.id, tenantId: tId, channel: 'alipay', scene: 'page', clientIp: '' });
    const ok = await c.post('/api/payments/notify/alipay', {
      sig: 'valid', event: 'payment', outTradeNo: (r as any).attemptId, txnId: 'ali_http', amountFen: 35000,
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toBe('success');
  });
  it('回调缺金额 → 不入账落差异(绝不默认通过)', async () => {
    const c = new Client(app);
    const o = newOrder();
    const r = await startPayment({ orderId: o.id, tenantId: tId, channel: 'wechat', scene: 'native', clientIp: '' });
    const ok = await c.post('/api/payments/notify/wechat', {
      sig: 'valid', event: 'payment', outTradeNo: (r as any).attemptId, txnId: 'wx_noamt',
    });
    expect(ok.status).toBe(200); // 差异已记录 → ACK(决策25,防重试风暴)
    expect(getOrder(o.id)!.status).toBe('pending_payment');
  });
  it('POST /orders/:id/check-payment:已付→入账;3s 限流第二次 throttled', async () => {
    const c = await loggedIn();
    const created = await c.post('/api/orders', { planId: createPlan({ name: 'HTTP查单版', priceYuan: 350, credits: 3500 }).id });
    const oid = created.body.order.id;
    await c.post(`/api/orders/${oid}/pay`, { channel: 'wechat', scene: 'native' });
    wx.queryResult = { status: 'paid', txnId: 'wx_check', paidAmountFen: 35000 };
    const r1 = await c.post(`/api/orders/${oid}/check-payment`, {});
    expect(r1.body.status).toBe('credited');
    const r2 = await c.post(`/api/orders/${oid}/check-payment`, {});
    expect(r2.body.throttled).toBe(true);
  });
  it('GET /api/payment-methods:offline + 通道场景;PUBLIC_BASE_URL 缺失时通道全空', async () => {
    const c = await loggedIn();
    const m1 = await c.get('/api/payment-methods');
    expect(m1.body.offline).toBe(true);
    expect(m1.body.channels.wechat).toContain('native');
    const saved = process.env.PUBLIC_BASE_URL;
    delete process.env.PUBLIC_BASE_URL;
    const m2 = await c.get('/api/payment-methods');
    expect(m2.body.channels.wechat).toEqual([]); // 决策26:基址未配 → 在线通道占位
    process.env.PUBLIC_BASE_URL = saved;
  });
  it('POST /orders/:id/pay:全链出码 + GET 订单详情带 pendingAttempt(刷新恢复)', async () => {
    const c = await loggedIn();
    const created = await c.post('/api/orders', { planId: createPlan({ name: 'HTTP出码版', priceYuan: 350, credits: 3500 }).id });
    const oid = created.body.order.id;
    const pay = await c.post(`/api/orders/${oid}/pay`, { channel: 'wechat', scene: 'native' });
    expect(pay.status).toBe(200);
    expect(pay.body.kind).toBe('qr');
    const detail = await c.get(`/api/orders/${oid}`);
    expect(detail.body.pendingAttempt.attemptId).toBe(pay.body.attemptId);
  });
  it('取消订单:未付→通道关单+取消;已付→409 已入账', async () => {
    const c = await loggedIn();
    const created = await c.post('/api/orders', { planId: createPlan({ name: 'HTTP取消版', priceYuan: 350, credits: 3500 }).id });
    const oid = created.body.order.id;
    await c.post(`/api/orders/${oid}/pay`, { channel: 'wechat', scene: 'native' });
    wx.queryResult = { status: 'paid', txnId: 'wx_cxl', paidAmountFen: 35000 };
    const r = await c.post(`/api/orders/${oid}/cancel`);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('ALREADY_PAID');
    expect(getOrder(oid)!.status).toBe('credited');
  });

  it('取消订单:通道关单失败 → 502 不放行取消(旧码可能仍活,防「取消后又被扣款」)', async () => {
    const c = await loggedIn();
    const created = await c.post('/api/orders', { planId: createPlan({ name: 'HTTP关单败版', priceYuan: 350, credits: 3500 }).id });
    const oid = created.body.order.id;
    await c.post(`/api/orders/${oid}/pay`, { channel: 'wechat', scene: 'native' });
    wx.provider.closePayment = async () => { throw new Error('通道不可达'); };
    const r = await c.post(`/api/orders/${oid}/cancel`);
    expect(r.status).toBe(502);
    expect(getOrder(oid)!.status).toBe('pending_payment'); // 订单未被取消
    expect(pendingAttemptForOrder(oid)!.status).toBe('pending'); // 码仍在途,稍后重试
  });

  it('回调端点边界:未知通道→404;通道未配置(迟到通知)→503 让通道重试', async () => {
    const c = new Client(app);
    const bad = await c.post('/api/payments/notify/paypal', { sig: 'valid' });
    expect(bad.status).toBe(404);
    setProviderForTest('wechat', null); // 移除注入 → 走真实构建:配置行无密钥 → provider null
    const late = await c.post('/api/payments/notify/wechat', { sig: 'valid', event: 'payment', outTradeNo: 'x'.repeat(32) });
    expect(late.status).toBe(503);
  });

  it('混沌:回调处理中抛异常 → 微信 500 JSON / 支付宝 200 failure(通道重试自愈)', async () => {
    const c = new Client(app);
    wx.provider.verifyNotify = async () => { throw new Error('db down'); };
    const rw = await c.post('/api/payments/notify/wechat', { sig: 'valid' });
    expect(rw.status).toBe(500);
    expect(rw.body.code).toBe('FAIL');
    ali.provider.verifyNotify = async () => { throw new Error('db down'); };
    const ra = await c.post('/api/payments/notify/alipay', { sig: 'valid' });
    expect(ra.status).toBe(200);
    expect(ra.body).toBe('failure'); // 支付宝按响应体字面量判重试(决策9/25)
  });

  it('微信退款异步通知(HTTP):refund_no 不符→忽略仍 ACK;相符→refunded+ledger 追回', async () => {
    const o = newOrder();
    const r = await startPayment({ orderId: o.id, tenantId: tId, channel: 'wechat', scene: 'native', clientIp: '' });
    const attemptId = (r as any).attemptId as string;
    applyPaymentSuccess('wechat', attemptId, 'wx_rn', 35000);
    wx.provider.refund = async () => ({ status: 'processing' as const }); // 微信形态:受理后等异步通知
    expect(await startRefund(o.id, 'padmin-http', '客户申请')).toBe('refunding');
    const refundNo = getAttempt(attemptId)!.refund_no!;
    const c = new Client(app);
    const mismatch = await c.post('/api/payments/notify/wechat', {
      sig: 'valid', event: 'refund', outTradeNo: attemptId, refundNo: 'RF_WRONG', refundStatus: 'succeeded',
    });
    expect(mismatch.status).toBe(200); // ACK 防重试风暴,但不落账
    expect(getAttempt(attemptId)!.status).toBe('refunding');
    const before = balance(tId);
    const ok = await c.post('/api/payments/notify/wechat', {
      sig: 'valid', event: 'refund', outTradeNo: attemptId, refundNo, refundStatus: 'succeeded',
    });
    expect(ok.status).toBe(200);
    expect(getAttempt(attemptId)!.status).toBe('refunded');
    expect(getOrder(o.id)!.status).toBe('refunded');
    expect(balance(tId)).toBe(before - 3850); // credits+bonus 全额追回
  });
});

describe('sweep 护栏 + 建单/出码守卫(决策6/13/24)', () => {
  it('超时 sweep 防误杀:仍有 pending 在线码的订单跳过;码 expired 后才取消', async () => {
    const o = newOrder();
    const r = await startPayment({ orderId: o.id, tenantId: tId, channel: 'wechat', scene: 'native', clientIp: '' });
    const attemptId = (r as any).attemptId as string;
    db.prepare(`UPDATE recharge_order SET created_at=? WHERE id=?`).run(Date.now() - PENDING_PAYMENT_TTL_MS - 60_000, o.id);
    cancelStalePendingOrders();
    expect(getOrder(o.id)!.status).toBe('pending_payment'); // 在途码保护,不被误杀
    db.prepare(`UPDATE payment_attempt SET expires_at=? WHERE id=?`).run(Date.now() - 1000, attemptId);
    await sweepExpiredAttempts(); // 先查单定生死(默认 pending → 关单 expired)
    expect(getAttempt(attemptId)!.status).toBe('expired');
    cancelStalePendingOrders();
    expect(getOrder(o.id)!.status).toBe('cancelled');
  });

  it('订单临近超时(<30s)不再出码 → ORDER_EXPIRING(码 TTL 锚点 ≤ 订单 TTL,决策24)', async () => {
    const o = newOrder();
    db.prepare(`UPDATE recharge_order SET created_at=? WHERE id=?`).run(Date.now() - PENDING_PAYMENT_TTL_MS + 20_000, o.id);
    await expect(startPayment({ orderId: o.id, tenantId: tId, channel: 'wechat', scene: 'native', clientIp: '' }))
      .rejects.toMatchObject({ code: 'ORDER_EXPIRING' });
  });

  it('决策6:只配在线未配对公的部署形态也能建单(payee 空 + 在线通道可用)', () => {
    setPayee({ payeeName: '', taxNo: '', bankName: '', bankAccount: '' });
    try {
      const o = createOrder({
        tenantId: tId, userId: admin,
        planId: createPlan({ name: `纯在线#${++planSeq}`, priceYuan: 100, credits: 1000 }).id,
      });
      expect(o.status).toBe('pending_payment');
    } finally {
      setPayee({ payeeName: '测试公司', taxNo: 'T', bankName: '测试行', bankAccount: '622' });
    }
  });
});
