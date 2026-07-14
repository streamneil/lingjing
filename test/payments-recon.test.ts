// 灵镜 在线支付 — 每日对账(D4.3 + 决策19/25):四类差异 + 重跑幂等 + 账单未生成顺延。

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

process.env.DB_FILE = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://pay-test.example.com';

const { db } = await import('../src/db/index.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { createPlan } = await import('../src/pricing/index.js');
const {
  createOrder, setPayee, startPayment, applyPaymentSuccess,
} = await import('../src/orders/index.js');
const { setProviderForTest, saveChannelSetting, BillNotReadyError } = await import('../src/payments/index.js');
const { reconcileChannel, cstDateString, listReconDiffs, resolveReconDiff, openReconDiffCount } = await import('../src/payments/recon.js');
import type { BillRow } from '../src/payments/types.js';

let tId = '', admin = '';
let bill: BillRow[] | 'not_ready' = [];

beforeAll(async () => {
  tId = createTenant('对账台').id;
  admin = (await createUser(tId, 'rcadmin2', 'pw123456', 'admin')).id;
  setPayee({ payeeName: '公司', taxNo: 'T', bankName: '行', bankAccount: '622' });
  saveChannelSetting('wechat', { enabledScenes: ['native'], config: {} });
});

beforeEach(() => {
  bill = [];
  setProviderForTest('wechat', {
    channel: 'wechat',
    async createPayment(i: any) { return { kind: 'qr', payload: `pay://${i.attemptId}` }; },
    async queryPayment() { return { status: 'pending' }; },
    async verifyNotify() { throw new Error('unused'); },
    async closePayment() {},
    async refund() { return { status: 'succeeded' }; },
    async downloadBill() {
      if (bill === 'not_ready') throw new BillNotReadyError();
      return bill;
    },
  } as never);
  db.prepare(`DELETE FROM recon_diff`).run();
  db.prepare(`DELETE FROM recon_run`).run();
  db.prepare(`DELETE FROM payment_attempt`).run(); // 对账按「当日全量尝试」对平,清掉上个用例的

});

let seq = 0;
async function paidAttempt(amountFen = 10000) {
  const planId = createPlan({ name: `对账版#${++seq}`, priceYuan: amountFen / 100, credits: 1000 }).id;
  const o = createOrder({ tenantId: tId, userId: admin, planId });
  const r = await startPayment({ orderId: o.id, tenantId: tId, channel: 'wechat', scene: 'native', clientIp: '' });
  const attemptId = (r as any).attemptId as string;
  applyPaymentSuccess('wechat', attemptId, `txn_rc_${seq}`, amountFen);
  return attemptId;
}

// 账单日按「该 attempt 的真实 paid_at」推导,而非 Date.now() —— 跑测试时若正好跨过
// 北京时间午夜(16:00 UTC),now() 与 paid_at 会落在不同账单日,用例随机挂(flake)。
const today = () => cstDateString(Date.now());
const billDateOf = (attemptId: string) => {
  const row = db.prepare(`SELECT paid_at, created_at FROM payment_attempt WHERE id=?`).get(attemptId) as
    | { paid_at: number | null; created_at: number }
    | undefined;
  return cstDateString(row?.paid_at ?? row?.created_at ?? Date.now());
};

describe('对账四类差异', () => {
  it('全对平 → 0 差异', async () => {
    const a = await paidAttempt();
    bill = [{ outTradeNo: a, txnId: 'txn_x', amountFen: 10000, status: 'paid' }];
    expect(await reconcileChannel(billDateOf(a), 'wechat')).toBe(0);
  });
  it('账单有本地无 → missing_local(最严重:收了钱不知道)', async () => {
    bill = [{ outTradeNo: 'ffffffff'.repeat(4), txnId: 'txn_ghost', amountFen: 5000, status: 'paid' }];
    expect(await reconcileChannel(today(), 'wechat')).toBe(1);
    const d = listReconDiffs({})[0] as any;
    expect(d.kind).toBe('missing_local');
  });
  it('通道已收款、本地未入账态 → status_mismatch(漏回调且 sweep 没兜住)', async () => {
    // 构造:pending attempt(未入账)但账单显示已支付
    const planId = createPlan({ name: `漏单版#${++seq}`, priceYuan: 100, credits: 1000 }).id;
    const o = createOrder({ tenantId: tId, userId: admin, planId });
    const r = await startPayment({ orderId: o.id, tenantId: tId, channel: 'wechat', scene: 'native', clientIp: '' });
    bill = [{ outTradeNo: (r as any).attemptId, txnId: 'txn_miss', amountFen: 10000, status: 'paid' }];
    expect(await reconcileChannel(today(), 'wechat')).toBe(1);
    expect((listReconDiffs({})[0] as any).kind).toBe('status_mismatch');
  });
  it('金额不符 → amount_mismatch', async () => {
    const a = await paidAttempt();
    bill = [{ outTradeNo: a, txnId: 'txn_amt', amountFen: 9999, status: 'paid' }];
    expect(await reconcileChannel(billDateOf(a), 'wechat')).toBe(1);
    expect((listReconDiffs({})[0] as any).kind).toBe('amount_mismatch');
  });
  it('本地已收款、账单没有 → missing_channel(单边账)', async () => {
    const a = await paidAttempt();
    bill = [];
    expect(await reconcileChannel(billDateOf(a), 'wechat')).toBe(1);
    expect((listReconDiffs({})[0] as any).kind).toBe('missing_channel');
  });
});

describe('对账幂等与顺延', () => {
  it('重跑不刷屏:同差异 INSERT OR IGNORE(决策25)', async () => {
    bill = [{ outTradeNo: 'eeeeeeee'.repeat(4), txnId: 'txn_dup', amountFen: 100, status: 'paid' }];
    await reconcileChannel(today(), 'wechat');
    await reconcileChannel(today(), 'wechat');
    await reconcileChannel(today(), 'wechat');
    expect(openReconDiffCount()).toBe(1);
  });
  it('账单未生成 → 返回 null(顺延),recon_run 记 bill_not_ready', async () => {
    bill = 'not_ready';
    expect(await reconcileChannel(today(), 'wechat')).toBe(null);
    const run = db.prepare(`SELECT status FROM recon_run WHERE bill_date=? AND channel='wechat'`).get(today()) as any;
    expect(run.status).toBe('bill_not_ready');
  });
  it('差异 resolve 幂等:第二次标记返回 false', async () => {
    bill = [{ outTradeNo: 'dddddddd'.repeat(4), txnId: 'txn_rs', amountFen: 100, status: 'paid' }];
    await reconcileChannel(today(), 'wechat');
    const d = listReconDiffs({})[0] as any;
    expect(resolveReconDiff(d.id)).toBe(true);
    expect(resolveReconDiff(d.id)).toBe(false);
    expect(openReconDiffCount()).toBe(0);
  });
});
