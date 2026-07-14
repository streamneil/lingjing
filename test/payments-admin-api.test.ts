// 灵镜 在线支付 — 超管 HTTP 端点(通道配置 / 退款 / 对账差异)。
//
// 评审补测:这些是「动钱」的路由(整单退款、差异单退款),此前只有服务层有测试,
// 路由层的鉴权、参数校验、错误码映射、密钥不外泄 全无覆盖 —— 回归会静默绿。

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';

process.env.DB_FILE = ':memory:';
process.env.MASTER_KEY = 'admin-api-test-master-key';
process.env.PUBLIC_BASE_URL = 'https://pay-test.example.com';
process.env.SUPERADMIN_USER = 'admin';
process.env.SUPERADMIN_PASS = 'superpw123';

const { createApp } = await import('../src/server.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { bootstrapSuperadmin } = await import('../src/auth/platform.js');
const { createPlan } = await import('../src/pricing/index.js');
const { balance } = await import('../src/credits/index.js');
const {
  createOrder, getOrder, setPayee, startPayment, applyPaymentSuccess, getAttempt,
} = await import('../src/orders/index.js');
const { setProviderForTest, saveChannelSetting } = await import('../src/payments/index.js');
const { Client } = await import('./helpers.js');

const app = createApp();
const kp = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIV = kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PUB = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString();

let tId = '', tenantAdmin = '';
let refundBehavior: { status: 'succeeded' } | { status: 'failed'; reason: string } = { status: 'succeeded' };

async function padmin(): Promise<InstanceType<typeof Client>> {
  const c = new Client(app);
  const r = await c.login('admin', 'superpw123', '/admin/login');
  expect(r.status).toBe(200);
  return c;
}

beforeAll(async () => {
  await bootstrapSuperadmin();
  tId = createTenant('超管API台').id;
  tenantAdmin = (await createUser(tId, 'padm-tenant', 'pw123456', 'admin')).id;
  setPayee({ payeeName: '公司', taxNo: 'T', bankName: '行', bankAccount: '622' });
  saveChannelSetting('wechat', { enabledScenes: ['native'], config: {} });
});

beforeEach(() => {
  refundBehavior = { status: 'succeeded' };
  setProviderForTest('wechat', {
    channel: 'wechat',
    async createPayment(i: any) { return { kind: 'qr', payload: `pay://${i.attemptId}` }; },
    async queryPayment() { return { status: 'pending' }; },
    async verifyNotify() { throw new Error('unused'); },
    async closePayment() {},
    async refund() { return refundBehavior; },
    async downloadBill() { return []; },
  } as never);
});

let seq = 0;
async function creditedOrder() {
  const planId = createPlan({ name: `超管版#${++seq}`, priceYuan: 100, credits: 1000 }).id;
  const o = createOrder({ tenantId: tId, userId: tenantAdmin, planId });
  const r = await startPayment({ orderId: o.id, tenantId: tId, channel: 'wechat', scene: 'native', clientIp: '' });
  const attemptId = (r as any).attemptId as string;
  applyPaymentSuccess('wechat', attemptId, `txn_a${seq}`, 10000);
  return { orderId: o.id, attemptId };
}

describe('鉴权隔离(动钱路由绝不能被租户打到)', () => {
  it('未登录 / 租户 session 打超管退款端点 → 401', async () => {
    const { orderId } = await creditedOrder();
    const anon = new Client(app);
    expect((await anon.post(`/admin/api/recharge-orders/${orderId}/refund`, { reason: 'x' })).status).toBe(401);
    const tenant = new Client(app);
    await tenant.login('padm-tenant', 'pw123456'); // 租户 session(lj_session ≠ lj_padmin)
    expect((await tenant.post(`/admin/api/recharge-orders/${orderId}/refund`, { reason: 'x' })).status).toBe(401);
    expect((await tenant.get('/admin/api/payment-channels')).status).toBe(401);
    expect((await tenant.get('/admin/api/recon-diffs')).status).toBe(401);
    expect(getOrder(orderId)!.status).toBe('credited'); // 钱没动
  });
});

describe('通道配置端点', () => {
  it('PUT 保存 + GET 回显:响应体绝不含私钥明文', async () => {
    const c = await padmin();
    const put = await c.put('/admin/api/payment-channels/wechat', {
      enabledScenes: ['native', 'h5'],
      config: { appid: 'wx1', mchid: '190001', merchantSerial: 'S1', publicKeyId: 'PUB_KEY_ID_1', publicKeyPem: PUB },
      secrets: { apiV3Key: 'k'.repeat(32), privateKeyPem: PRIV },
    });
    expect(put.status).toBe(200);
    expect(JSON.stringify(put.body)).not.toContain('PRIVATE KEY');
    const get = await c.get('/admin/api/payment-channels');
    expect(get.status).toBe(200);
    expect(JSON.stringify(get.body)).not.toContain('PRIVATE KEY');
    const wx = get.body.channels.find((x: any) => x.channel === 'wechat');
    expect(wx.secretsConfigured).toBe(true);
    expect(wx.enabledScenes).toEqual(['native', 'h5']);
    expect(get.body.masterKeyReady).toBe(true);
    expect(get.body.publicBaseUrl).toBe('https://pay-test.example.com');
  });
  it('未知通道 → 404;坏私钥 → 400(不落库)', async () => {
    const c = await padmin();
    expect((await c.put('/admin/api/payment-channels/paypal', { enabledScenes: [] })).status).toBe(404);
    const bad = await c.put('/admin/api/payment-channels/alipay', {
      enabledScenes: ['page'], config: { appId: 'a', alipayPublicKeyPem: PUB }, secrets: { privateKeyPem: 'garbage' },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/PEM/);
  });
});

describe('退款端点', () => {
  it('缺原因 → 400;正常退款 → 200 + 积分扣回', async () => {
    const c = await padmin();
    const { orderId } = await creditedOrder();
    const before = balance(tId);
    expect((await c.post(`/admin/api/recharge-orders/${orderId}/refund`, {})).status).toBe(400);
    expect(balance(tId)).toBe(before);
    const ok = await c.post(`/admin/api/recharge-orders/${orderId}/refund`, { reason: '客户申请' });
    expect(ok.status).toBe(200);
    expect(ok.body.outcome).toBe('refunded');
    expect(getOrder(orderId)!.status).toBe('refunded');
    expect(balance(tId)).toBe(before - 1000);
  });
  it('通道退款失败 → 502 带原因,订单回退 credited(不卡死)', async () => {
    const c = await padmin();
    const { orderId } = await creditedOrder();
    refundBehavior = { status: 'failed', reason: '商户余额不足' };
    const r = await c.post(`/admin/api/recharge-orders/${orderId}/refund`, { reason: 'x' });
    expect(r.status).toBe(502);
    expect(r.body.error).toContain('余额不足');
    expect(getOrder(orderId)!.status).toBe('credited');
  });
  it('订单不存在 → 404', async () => {
    const c = await padmin();
    expect((await c.post('/admin/api/recharge-orders/nope/refund', { reason: 'x' })).status).toBe(404);
  });
  it('差异单退款端点:已入账流水 → 409 ATTEMPT_CREDITED_ORDER(防退钱不扣分)', async () => {
    const c = await padmin();
    const { attemptId } = await creditedOrder();
    const r = await c.post(`/admin/api/payment-attempts/${attemptId}/refund`, { reason: '误点' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('ATTEMPT_CREDITED_ORDER');
    expect(getAttempt(attemptId)!.status).toBe('paid');
  });
});

describe('对账差异端点', () => {
  it('列差异 + 标记已处理(幂等:二次 409)', async () => {
    const c = await padmin();
    // 造一条差异:未知 out_trade_no 的成功回调
    applyPaymentSuccess('wechat', 'ffffffff'.repeat(4), 'txn_ghost', 100);
    const list = await c.get('/admin/api/recon-diffs?resolved=0');
    expect(list.status).toBe(200);
    expect(list.body.openCount).toBeGreaterThan(0);
    const d = list.body.diffs[0];
    expect(d.kind).toBe('missing_local');
    expect((await c.post(`/admin/api/recon-diffs/${d.id}/resolve`, {})).status).toBe(200);
    expect((await c.post(`/admin/api/recon-diffs/${d.id}/resolve`, {})).status).toBe(409);
  });
});

describe('订单管理视图枚举(admin 已退款 tab 回归)', () => {
  it('view=refunded / refunding 不再 400(新 tab 可加载)', async () => {
    const c = await padmin();
    for (const v of ['refunded', 'refunding', 'todo', 'all', 'credited']) {
      const r = await c.get(`/admin/api/recharge-orders?view=${v}`);
      expect(r.status, `view=${v}`).toBe(200);
    }
    expect((await c.get('/admin/api/recharge-orders?view=bogus')).status).toBe(400);
  });
});
