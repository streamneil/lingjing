// 灵镜 在线支付 — 通道层单测:元分换算护栏 / 微信 v3 验签+解密 / 支付宝 RSA2 验签 / 账单解析。
//
// 验签向量:测试内生成 RSA 密钥对模拟「平台侧签名 → 我方验签」,覆盖:
//   正向通过、伪签、篡改 body、过期时间戳、serial 不符、APIv3 解密失败 —— 全部离线零外呼。
// 金额护栏(134× 事故回归铁律):¥350→35000 分;非整数分/负数/0/NaN → 抛。

import { describe, it, expect } from 'vitest';
import {
  generateKeyPairSync,
  createSign,
  createVerify,
  createCipheriv,
  randomBytes,
} from 'node:crypto';
import { deflateRawSync } from 'node:zlib';

process.env.DB_FILE = ':memory:';

const { yuanToFen, fenToYuan, fenToYuanString, yuanStringToFen } = await import('../src/payments/money.js');
const { PaymentError } = await import('../src/payments/types.js');
const { WechatProvider } = await import('../src/payments/wechat.js');
const { AlipayProvider } = await import('../src/payments/alipay.js');

// ── 密钥对:merchant(我方)+ platform(模拟微信/支付宝侧)──
const pem = () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    priv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    pub: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
};
const merchant = pem();
const platform = pem();
const API_V3_KEY = 'a'.repeat(32);

function wechat() {
  return new WechatProvider({
    appid: 'wx_test_app',
    mchid: '1900000001',
    merchantSerial: 'MCHSERIAL01',
    publicKeyId: 'PUB_KEY_ID_TEST01',
    publicKeyPem: platform.pub,
    apiV3Key: API_V3_KEY,
    privateKeyPem: merchant.priv,
  });
}

/** 构造一条合法微信支付成功通知(平台私钥签名 + APIv3 密钥加密)。 */
function wechatNotify(obj: Record<string, unknown>, eventType = 'TRANSACTION.SUCCESS') {
  const nonceStr = 'noncenoncenon';
  const aad = 'transaction';
  const iv = Buffer.from(nonceStr, 'utf8');
  const c = createCipheriv('aes-256-gcm', Buffer.from(API_V3_KEY, 'utf8'), iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const cipherBody = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final(), c.getAuthTag()]);
  const body = Buffer.from(
    JSON.stringify({
      event_type: eventType,
      resource: { ciphertext: cipherBody.toString('base64'), nonce: nonceStr, associated_data: aad },
    }),
  );
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(8).toString('hex');
  const sig = createSign('RSA-SHA256').update(`${ts}\n${nonce}\n${body.toString('utf8')}\n`).sign(platform.priv, 'base64');
  const headers = {
    'wechatpay-timestamp': ts,
    'wechatpay-nonce': nonce,
    'wechatpay-signature': sig,
    'wechatpay-serial': 'PUB_KEY_ID_TEST01',
  };
  return { body, headers };
}

describe('元分换算唯一点(134× 事故护栏)', () => {
  it('¥350 → 35000 分;¥5000 → 500000 分', () => {
    expect(yuanToFen(350)).toBe(35000);
    expect(yuanToFen(5000)).toBe(500000);
    expect(fenToYuan(35000)).toBe(350);
  });
  it('小数元(0.01)合法;非整数分(0.011)拒', () => {
    expect(yuanToFen(0.01)).toBe(1);
    expect(() => yuanToFen(0.011)).toThrow(PaymentError);
  });
  it('0 / 负数 / NaN / Infinity → 拒', () => {
    for (const bad of [0, -1, NaN, Infinity]) expect(() => yuanToFen(bad)).toThrow(PaymentError);
  });
  it('支付宝元字符串两位小数往返', () => {
    expect(fenToYuanString(35000)).toBe('350.00');
    expect(fenToYuanString(1)).toBe('0.01');
    expect(yuanStringToFen('350.00')).toBe(35000);
    expect(() => yuanStringToFen('abc')).toThrow(PaymentError);
  });
});

describe('微信 v3 回调验签 + AES-GCM 解密(公钥模式)', () => {
  it('合法支付成功通知 → ok + 字段归一', async () => {
    const { body, headers } = wechatNotify({
      out_trade_no: 'attempt0001',
      transaction_id: 'wx_txn_001',
      trade_state: 'SUCCESS',
      amount: { total: 35000, payer_total: 35000 },
      success_time: '2026-07-14T10:00:00+08:00',
    });
    const r = await wechat().verifyNotify(body, headers);
    expect(r.ok).toBe(true);
    expect(r.event).toBe('payment');
    expect(r.outTradeNo).toBe('attempt0001');
    expect(r.txnId).toBe('wx_txn_001');
    expect(r.paidAmountFen).toBe(35000);
    expect(r.ack.status).toBe(200);
    expect(r.ack.body).toContain('SUCCESS');
  });
  it('退款通知 → event=refund + refundStatus', async () => {
    const { body, headers } = wechatNotify(
      { out_trade_no: 'attempt0001', out_refund_no: 'RFxxx', refund_status: 'SUCCESS', amount: { refund: 35000 } },
      'REFUND.SUCCESS',
    );
    const r = await wechat().verifyNotify(body, headers);
    expect(r.ok).toBe(true);
    expect(r.event).toBe('refund');
    expect(r.refundStatus).toBe('succeeded');
    expect(r.refundNo).toBe('RFxxx');
  });
  it('伪签(别人私钥)→ ok:false + 4xx ACK', async () => {
    const evil = pem();
    const { body, headers } = wechatNotify({ out_trade_no: 'x' });
    const ts = headers['wechatpay-timestamp'];
    headers['wechatpay-signature'] = createSign('RSA-SHA256')
      .update(`${ts}\n${headers['wechatpay-nonce']}\n${body.toString('utf8')}\n`)
      .sign(evil.priv, 'base64');
    const r = await wechat().verifyNotify(body, headers);
    expect(r.ok).toBe(false);
    expect(r.ack.status).toBe(401);
  });
  it('篡改 body(改 1 字节)→ ok:false', async () => {
    const { body, headers } = wechatNotify({ out_trade_no: 'x' });
    const tampered = Buffer.from(body);
    tampered[tampered.length - 3] = tampered[tampered.length - 3]! ^ 1;
    const r = await wechat().verifyNotify(tampered, headers);
    expect(r.ok).toBe(false);
  });
  it('过期时间戳(±5min 外)→ ok:false(防重放)', async () => {
    const { body, headers } = wechatNotify({ out_trade_no: 'x' });
    const oldTs = String(Math.floor(Date.now() / 1000) - 600);
    headers['wechatpay-timestamp'] = oldTs;
    headers['wechatpay-signature'] = createSign('RSA-SHA256')
      .update(`${oldTs}\n${headers['wechatpay-nonce']}\n${body.toString('utf8')}\n`)
      .sign(platform.priv, 'base64');
    const r = await wechat().verifyNotify(body, headers);
    expect(r.ok).toBe(false);
  });
  it('serial 与公钥 ID 不符 → ok:false', async () => {
    const { body, headers } = wechatNotify({ out_trade_no: 'x' });
    headers['wechatpay-serial'] = 'PUB_KEY_ID_OTHER';
    const r = await wechat().verifyNotify(body, headers);
    expect(r.ok).toBe(false);
  });
  it('APIv3 密钥不符 → 解密失败 ok:false', async () => {
    const { body, headers } = wechatNotify({ out_trade_no: 'x' });
    const p = new WechatProvider({
      appid: 'wx_test_app', mchid: '1900000001', merchantSerial: 'MCHSERIAL01',
      publicKeyId: 'PUB_KEY_ID_TEST01', publicKeyPem: platform.pub,
      apiV3Key: 'b'.repeat(32), privateKeyPem: merchant.priv,
    });
    const r = await p.verifyNotify(body, headers);
    expect(r.ok).toBe(false);
  });
  it('无关事件(验签通过)→ event=ignored + ACK 成功(不重试)', async () => {
    const { body, headers } = wechatNotify({ foo: 1 }, 'TRANSACTION.CLOSED');
    const r = await wechat().verifyNotify(body, headers);
    expect(r.ok).toBe(true);
    expect(r.event).toBe('ignored');
    expect(r.ack.status).toBe(200);
  });
});

describe('微信交易账单 CSV 解析', () => {
  it('按表头定位列;反引号剥离;汇总段忽略', () => {
    const csv = [
      '交易时间,公众账号ID,商户号,特约商户号,设备号,微信支付订单号,商户订单号,用户标识,交易类型,交易状态,付款银行,货币种类,总金额,代金券金额,微信退款单号,商户退款单号,退款金额,充值券退款金额,退款类型,退款状态,商品名称,商户数据包,手续费,费率,订单金额,申请退款金额,费率备注',
      '`2026-07-13 10:00:00,`wx_app,`1900000001,`0,`0,`wx_txn_001,`attempt0001,`oUser,`NATIVE,`SUCCESS,`OTHERS,`CNY,`350.00,`0.00,`0,`0,`0.00,`0.00,`,`,`灵镜积分充值,`,`1.05,`0.30%,`350.00,`0.00,`',
      '总交易单数,应结订单总金额,退款总金额,充值券退款总金额,手续费总金额,订单总金额,申请退款总金额',
      '`1,`350.00,`0.00,`0.00,`1.05,`350.00,`0.00',
    ].join('\n');
    const rows = WechatProvider.parseBillCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outTradeNo: 'attempt0001', txnId: 'wx_txn_001', amountFen: 35000, status: 'paid' });
  });
});

describe('微信账单金额列名护栏(评审 CRITICAL 回归)', () => {
  const row = (amountHeader: string) =>
    [
      `交易时间,公众账号ID,商户号,微信支付订单号,商户订单号,交易类型,交易状态,${amountHeader}`,
      '`2026-07-13 10:00:00,`wx_app,`190001,`wx_txn_9,`attempt9,`NATIVE,`SUCCESS,`350.00',
    ].join('\n');

  it('v3 表头「订单金额」→ 正确解析 35000 分(此前只认「总金额」→ 全表 0 分 → 每笔误判 amount_mismatch)', () => {
    const rows = WechatProvider.parseBillCsv(row('订单金额'));
    expect(rows[0]!.amountFen).toBe(35000);
  });
  it('v3 表头「应结订单金额」也认', () => {
    expect(WechatProvider.parseBillCsv(row('应结订单金额'))[0]!.amountFen).toBe(35000);
  });
  it('v2 遗留「总金额」仍认(向后兼容)', () => {
    expect(WechatProvider.parseBillCsv(row('总金额'))[0]!.amountFen).toBe(35000);
  });
  it('金额列完全缺失 → 抛协议错误(绝不静默按 0 对账,否则每笔成功单都成差异)', () => {
    expect(() => WechatProvider.parseBillCsv(row('手续费'))).toThrow(/金额列/);
  });
});

describe('支付宝 RSA2 验签(普通公钥模式)', () => {
  const alipay = () =>
    new AlipayProvider({
      appId: '2021000000000001',
      alipayPublicKeyPem: platform.pub, // platform 模拟支付宝侧
      gateway: 'https://openapi.alipay.com/gateway.do',
      privateKeyPem: merchant.priv,
    });

  function alipayNotify(params: Record<string, string>) {
    const content = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
    const sign = createSign('RSA-SHA256').update(content, 'utf8').sign(platform.priv, 'base64');
    const all = { ...params, sign, sign_type: 'RSA2' };
    return Buffer.from(new URLSearchParams(all).toString());
  }

  it('合法 TRADE_SUCCESS 通知 → ok + 金额分归一 + ACK=success 文本', async () => {
    const body = alipayNotify({
      app_id: '2021000000000001',
      out_trade_no: 'attempt0002',
      trade_no: 'ali_txn_002',
      trade_status: 'TRADE_SUCCESS',
      total_amount: '350.00',
      gmt_payment: '2026-07-13 10:00:00',
    });
    const r = await alipay().verifyNotify(body, {});
    expect(r.ok).toBe(true);
    expect(r.event).toBe('payment');
    expect(r.outTradeNo).toBe('attempt0002');
    expect(r.paidAmountFen).toBe(35000);
    expect(r.ack.body).toBe('success');
    expect(r.ack.contentType).toBe('text/plain');
  });
  it('伪签 → ok:false + ACK=failure(支付宝按响应体判重试)', async () => {
    const body = alipayNotify({ app_id: '2021000000000001', out_trade_no: 'x', trade_status: 'TRADE_SUCCESS', total_amount: '1.00' });
    const s = body.toString('utf8').replace(/sign=[^&]+/, 'sign=' + encodeURIComponent(Buffer.from('bad').toString('base64')));
    const r = await alipay().verifyNotify(Buffer.from(s), {});
    expect(r.ok).toBe(false);
    expect(r.ack.body).toBe('failure');
  });
  it('app_id 不符 → ok:false(串号防线)', async () => {
    const body = alipayNotify({ app_id: '9999', out_trade_no: 'x', trade_status: 'TRADE_SUCCESS', total_amount: '1.00' });
    const r = await alipay().verifyNotify(body, {});
    expect(r.ok).toBe(false);
  });
  it('非支付事件(TRADE_CLOSED)→ ignored + ACK success', async () => {
    const body = alipayNotify({ app_id: '2021000000000001', out_trade_no: 'x', trade_status: 'TRADE_CLOSED' });
    const r = await alipay().verifyNotify(body, {});
    expect(r.ok).toBe(true);
    expect(r.event).toBe('ignored');
    expect(r.ack.body).toBe('success');
  });
});

describe('支付宝下单 URL(离线构造,零外呼)', () => {
  const alipay = () =>
    new AlipayProvider({
      appId: '2021000000000001',
      alipayPublicKeyPem: platform.pub,
      gateway: 'https://openapi.alipay.com/gateway.do',
      privateKeyPem: merchant.priv,
    });

  it('page/wap:签名 GET URL 含单号/元字符串金额/product_code/time_expire;RSA2 签名可验', async () => {
    const attemptId = 'a'.repeat(32);
    const expiresAt = Date.parse('2026-07-14T12:00:00+08:00');
    const page = await alipay().createPayment({
      attemptId, amountFen: 35000, description: '灵镜积分充值-在线版', clientIp: '1.2.3.4',
      scene: 'page', notifyUrl: 'https://x.example.com/api/payments/notify/alipay',
      returnUrl: 'https://x.example.com/pay.html?order=o1', expiresAt,
    });
    expect(page.kind).toBe('redirect');
    const u = new URL(page.payload);
    expect(`${u.origin}${u.pathname}`).toBe('https://openapi.alipay.com/gateway.do');
    const q = u.searchParams;
    expect(q.get('method')).toBe('alipay.trade.page.pay');
    expect(q.get('notify_url')).toBe('https://x.example.com/api/payments/notify/alipay');
    expect(q.get('return_url')).toBe('https://x.example.com/pay.html?order=o1');
    const biz = JSON.parse(q.get('biz_content')!) as Record<string, unknown>;
    expect(biz.out_trade_no).toBe(attemptId);
    expect(biz.total_amount).toBe('350.00'); // 元字符串两位小数(money.ts 唯一点)
    expect(biz.product_code).toBe('FAST_INSTANT_TRADE_PAY');
    expect(biz.time_expire).toBe('2026-07-14 12:00:00'); // GMT+8,通道侧与本地 attempt 对齐(决策24)
    // 签名可用应用公钥验证(去 sign,字典序 k=v& 原文拼串)
    const params: Record<string, string> = {};
    for (const [k, v] of q) params[k] = v;
    const sign = params.sign!;
    delete params.sign;
    const content = Object.keys(params).filter((k) => params[k] !== '').sort().map((k) => `${k}=${params[k]}`).join('&');
    expect(createVerify('RSA-SHA256').update(content, 'utf8').verify(merchant.pub, sign, 'base64')).toBe(true);
    // wap 形态:QUICK_WAP_WAY + quit_url(中断返回页)
    const wap = await alipay().createPayment({
      attemptId, amountFen: 1, description: '一分钱', clientIp: '',
      scene: 'wap', notifyUrl: 'https://x.example.com/n', returnUrl: 'https://x.example.com/r', expiresAt,
    });
    const wapBiz = JSON.parse(new URL(wap.payload).searchParams.get('biz_content')!) as Record<string, unknown>;
    expect(new URL(wap.payload).searchParams.get('method')).toBe('alipay.trade.wap.pay');
    expect(wapBiz.product_code).toBe('QUICK_WAP_WAY');
    expect(wapBiz.quit_url).toBe('https://x.example.com/r');
    expect(wapBiz.total_amount).toBe('0.01');
  });
});

describe('支付宝账单 ZIP 解包 + 明细 CSV 解析', () => {
  /** 最小 ZIP 构造(deflate 压缩,单文件)——覆盖 EOCD→中央目录→局部头解包路径。 */
  function makeZip(name: string, content: Buffer): Buffer {
    const nameB = Buffer.from(name, 'utf8'); // 测试用 ASCII 名,GBK 兼容
    const comp = deflateRawSync(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameB.length, 26); local.writeUInt16LE(0, 28);
    const localAll = Buffer.concat([local, nameB, comp]);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(content.length, 24);
    cd.writeUInt16LE(nameB.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32);
    cd.writeUInt32LE(0, 42); // local offset
    const cdAll = Buffer.concat([cd, nameB]);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(cdAll.length, 12); eocd.writeUInt32LE(localAll.length, 16);
    return Buffer.concat([localAll, cdAll, eocd]);
  }

  const csv = [
    '#支付宝业务明细查询',
    '交易号,商户订单号,业务类型,商品名称,创建时间,完成时间,门店编号,门店名称,操作员,终端号,对方账户,订单金额(元),商家实收(元),支付宝红包(元),集分宝(元),支付宝优惠(元),商家优惠(元),券核销金额(元),券名称,商家红包消费金额(元),卡消费金额(元),退款批次号/请求号,服务费(元),分润(元),备注',
    'ali_txn_002,attempt0002,交易,灵镜积分充值,2026-07-13 10:00:00,2026-07-13 10:00:05,,,,,buyer@x.com,350.00,349.00,0.00,0.00,0.00,0.00,0.00,,0.00,0.00,,1.00,0.00,',
    'ali_txn_003,attempt0003,退款,灵镜积分充值,2026-07-13 11:00:00,2026-07-13 11:00:05,,,,,buyer@x.com,-350.00,-349.00,0.00,0.00,0.00,0.00,0.00,,0.00,0.00,RF123,0.00,0.00,',
    '#-----------------------------------------',
    '#共2笔',
  ].join('\n');

  it('ZIP → 明细 CSV → 归一行(交易=paid,退款=refunded,金额取绝对值分)', () => {
    const zip = makeZip('20260713_业务明细.csv', Buffer.from(csv, 'utf8'));
    const text = AlipayProvider.extractBillCsv(zip);
    const rows = AlipayProvider.parseBillCsv(text);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ outTradeNo: 'attempt0002', txnId: 'ali_txn_002', amountFen: 35000, status: 'paid' });
    expect(rows[1]).toMatchObject({ outTradeNo: 'attempt0003', status: 'refunded' });
  });
  it('坏 ZIP → 抛协议错误', () => {
    expect(() => AlipayProvider.extractBillCsv(Buffer.from('not a zip'))).toThrow();
  });
});
