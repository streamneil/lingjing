// 灵镜 在线支付 — 微信支付 APIv3 Provider(公钥模式,决策14)。
//
// ┌─ 凭证体系(v1 仅「微信支付公钥」模式)──────────────────────────────────────┐
// │ 请求签名: 商户私钥 privateKeyPem RSA-SHA256(Authorization 头,serial=商户证书序列号) │
// │ 回调验签: 微信支付公钥 publicKeyPem(header wechatpay-serial 必须 = publicKeyId)      │
// │ 回调解密: APIv3 密钥 AES-256-GCM(resource.ciphertext)                                 │
// │ 平台证书模式(老商户,自动轮换)NOT in scope —— 配置页注明要求。                        │
// └────────────────────────────────────────────────────────────────────────────────┘
// 场景:native(PC 扫码,code_url)/ h5(手机浏览器,h5_url,5 分钟有效)。
// 金额:一律整数分(money.ts 唯一换算点)。out_trade_no = attempt id(32 hex,决策12/18)。
// 出网:undici + 可选 WECHAT_PROXY(复用 proxyDispatcher 范式;compose 转发见 .env.example)。

import { createSign, createVerify, createDecipheriv, randomBytes } from 'node:crypto';
import { fetch as undiciFetch } from 'undici';
import { proxyDispatcher } from '../gateway/sync-image-common.js';
import {
  BillNotReadyError,
  PaymentError,
  type BillRow,
  type CreatePaymentInput,
  type CreatePaymentResult,
  type NotifyResult,
  type PaymentProvider,
  type QueryResult,
  type RefundInput,
  type RefundResult,
} from './types.js';
import { yuanStringToFen } from './money.js';

export interface WechatConfig {
  appid: string;
  mchid: string;
  merchantSerial: string; // 商户 API 证书序列号(请求签名头用)
  publicKeyId: string; // 微信支付公钥 ID(PUB_KEY_ID_...;回调 wechatpay-serial 必须等于它)
  publicKeyPem: string; // 微信支付公钥(验签;非敏感)
  apiV3Key: string; // APIv3 密钥(回调解密;敏感)
  privateKeyPem: string; // 商户私钥(请求签名;敏感)
}

const BASE = 'https://api.mch.weixin.qq.com';
const NOTIFY_TS_TOLERANCE_MS = 5 * 60 * 1000; // 回调时间戳容差 ±5min(防重放)

const ACK_OK = { status: 200, body: '{"code":"SUCCESS","message":"成功"}', contentType: 'application/json' };
const ackFail = (status: number, msg: string) => ({
  status,
  body: JSON.stringify({ code: 'FAIL', message: msg }),
  contentType: 'application/json',
});

/** RFC3339 +08:00(微信 time_expire 要求)。 */
function rfc3339Cst(ms: number): string {
  const d = new Date(ms + 8 * 3600_000); // 转北京时间后按 UTC 字段格式化
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+08:00`
  );
}

export class WechatProvider implements PaymentProvider {
  readonly channel = 'wechat' as const;
  constructor(private cfg: WechatConfig) {}

  // ── v3 请求签名(RSA-SHA256 商户私钥)──
  private authHeader(method: string, pathWithQuery: string, body: string): string {
    const ts = Math.floor(Date.now() / 1000).toString();
    const nonce = randomBytes(16).toString('hex');
    const message = `${method}\n${pathWithQuery}\n${ts}\n${nonce}\n${body}\n`;
    const signature = createSign('RSA-SHA256').update(message).sign(this.cfg.privateKeyPem, 'base64');
    return (
      `WECHATPAY2-SHA256-RSA2048 mchid="${this.cfg.mchid}",nonce_str="${nonce}",` +
      `signature="${signature}",timestamp="${ts}",serial_no="${this.cfg.merchantSerial}"`
    );
  }

  private async request(
    method: 'GET' | 'POST',
    pathWithQuery: string,
    bodyObj?: unknown,
    baseUrl = BASE,
  ): Promise<{ status: number; text: string }> {
    const body = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
    const url = `${baseUrl}${pathWithQuery}`;
    let res: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      res = await undiciFetch(url, {
        method,
        headers: {
          Authorization: this.authHeader(method, pathWithQuery, body),
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'lingjing-payments/1.0',
        },
        body: method === 'POST' ? body : undefined,
        dispatcher: proxyDispatcher('WECHAT_PROXY'),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new PaymentError('UPSTREAM', `微信支付接口不可达: ${e instanceof Error ? e.message : e}`);
    }
    return { status: res.status, text: await res.text() };
  }

  private static errOf(text: string): { code?: string; message?: string } {
    try {
      return JSON.parse(text) as { code?: string; message?: string };
    } catch {
      return {};
    }
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const isH5 = input.scene === 'h5';
    const path = isH5 ? '/v3/pay/transactions/h5' : '/v3/pay/transactions/native';
    const body: Record<string, unknown> = {
      appid: this.cfg.appid,
      mchid: this.cfg.mchid,
      description: input.description,
      out_trade_no: input.attemptId,
      time_expire: rfc3339Cst(input.expiresAt),
      notify_url: input.notifyUrl,
      amount: { total: input.amountFen, currency: 'CNY' },
    };
    if (isH5) body.scene_info = { payer_client_ip: input.clientIp || '127.0.0.1', h5_info: { type: 'Wap' } };
    const { status, text } = await this.request('POST', path, body);
    if (status !== 200) {
      const e = WechatProvider.errOf(text);
      throw new PaymentError('UPSTREAM', `微信下单失败(${status} ${e.code ?? ''}): ${e.message ?? text.slice(0, 200)}`);
    }
    const data = JSON.parse(text) as { code_url?: string; h5_url?: string };
    const payload = isH5 ? data.h5_url : data.code_url;
    if (!payload) throw new PaymentError('PROTOCOL', '微信下单返回缺少支付链接');
    return isH5 ? { kind: 'redirect', payload } : { kind: 'qr', payload };
  }

  async queryPayment(attemptId: string): Promise<QueryResult> {
    const path = `/v3/pay/transactions/out-trade-no/${attemptId}?mchid=${this.cfg.mchid}`;
    const { status, text } = await this.request('GET', path);
    if (status === 404) return { status: 'not_found' };
    if (status !== 200) {
      const e = WechatProvider.errOf(text);
      if (e.code === 'ORDER_NOT_EXIST') return { status: 'not_found' };
      throw new PaymentError('UPSTREAM', `微信查单失败(${status}): ${e.message ?? text.slice(0, 200)}`);
    }
    const d = JSON.parse(text) as {
      trade_state: string;
      transaction_id?: string;
      amount?: { total?: number };
      success_time?: string;
    };
    if (d.trade_state === 'SUCCESS') {
      return {
        status: 'paid',
        txnId: d.transaction_id,
        paidAmountFen: d.amount?.total,
        paidAt: d.success_time ? Date.parse(d.success_time) : undefined,
      };
    }
    // REFUND:钱已(部分/全额)退回买家。当 paid 入账 = 白送积分(运营在商户后台手工退款后
    // 下一轮 sweep 就会踩到)。归一为独立状态,调用方落差异不入账。
    if (d.trade_state === 'REFUND') {
      return { status: 'refunded', txnId: d.transaction_id, paidAmountFen: d.amount?.total };
    }
    if (d.trade_state === 'CLOSED' || d.trade_state === 'REVOKED' || d.trade_state === 'PAYERROR')
      return { status: 'closed' };
    return { status: 'pending' }; // NOTPAY / USERPAYING
  }

  async closePayment(attemptId: string): Promise<void> {
    const { status, text } = await this.request(
      'POST',
      `/v3/pay/transactions/out-trade-no/${attemptId}/close`,
      { mchid: this.cfg.mchid },
    );
    if (status === 204) return;
    const e = WechatProvider.errOf(text);
    // 幂等:已关/不存在都视为成功;ORDER_PAID 交给调用方(先查单再关的流程通常不会走到)。
    if (e.code === 'ORDER_CLOSED' || e.code === 'ORDER_NOT_EXIST' || status === 404) return;
    throw new PaymentError('UPSTREAM', `微信关单失败(${status} ${e.code ?? ''}): ${e.message ?? ''}`);
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const { status, text } = await this.request('POST', '/v3/refund/domestic/refunds', {
      out_trade_no: input.attemptId,
      out_refund_no: input.refundNo,
      reason: input.reason.slice(0, 80),
      notify_url: input.notifyUrl,
      amount: { refund: input.amountFen, total: input.amountFen, currency: 'CNY' },
    });
    if (status === 200) {
      const d = JSON.parse(text) as { status?: string };
      if (d.status === 'SUCCESS') return { status: 'succeeded' };
      if (d.status === 'PROCESSING') return { status: 'processing' }; // 结果走退款异步通知
      return { status: 'failed', reason: `微信退款状态异常: ${d.status ?? '未知'}` };
    }
    const e = WechatProvider.errOf(text);
    // 「被拒」与「结果未知」必须分开(评审 HIGH):5xx / 无业务码 = 微信可能已受理退款,
    // 判成 failed 会把订单回滚成 credited,随后真正的退款成功通知又匹配不上 → 钱退了、积分没扣。
    // 结果未知 → 抛 UPSTREAM,调用方保持 refunding(停滞 10 分钟后可安全重驱,同 refund_no 幂等)。
    if (status >= 500 || !e.code)
      throw new PaymentError('UPSTREAM', `微信退款结果未知(${status} ${e.message ?? ''})`);
    return { status: 'failed', reason: `微信退款被拒(${status} ${e.code}): ${e.message ?? ''}` };
  }

  // ── 回调:验签(微信支付公钥)→ AES-256-GCM 解密 → 归一 NotifyResult ──
  async verifyNotify(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<NotifyResult> {
    const h = (k: string) => {
      const v = headers[k];
      return Array.isArray(v) ? v[0] : v;
    };
    const ts = h('wechatpay-timestamp');
    const nonce = h('wechatpay-nonce');
    const sig = h('wechatpay-signature');
    const serial = h('wechatpay-serial');
    const fail = (msg: string): NotifyResult => ({ ok: false, event: 'ignored', ack: ackFail(401, msg) });
    if (!ts || !nonce || !sig || !serial) return fail('缺少验签头');
    if (serial !== this.cfg.publicKeyId) return fail('serial 与微信支付公钥 ID 不符');
    const tsMs = Number(ts) * 1000;
    if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > NOTIFY_TS_TOLERANCE_MS)
      return fail('时间戳超出容差');
    const message = `${ts}\n${nonce}\n${rawBody.toString('utf8')}\n`;
    let verified = false;
    try {
      verified = createVerify('RSA-SHA256').update(message).verify(this.cfg.publicKeyPem, sig, 'base64');
    } catch {
      verified = false;
    }
    if (!verified) return fail('验签失败');

    let evt: { event_type?: string; resource?: { ciphertext?: string; nonce?: string; associated_data?: string } };
    try {
      evt = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return fail('回调体非 JSON');
    }
    const r = evt.resource;
    if (!r?.ciphertext || !r.nonce) return fail('回调缺少密文');
    let plain: string;
    try {
      const data = Buffer.from(r.ciphertext, 'base64');
      const tag = data.subarray(data.length - 16);
      const cipher = data.subarray(0, data.length - 16);
      const d = createDecipheriv('aes-256-gcm', Buffer.from(this.cfg.apiV3Key, 'utf8'), Buffer.from(r.nonce, 'utf8'));
      if (r.associated_data) d.setAAD(Buffer.from(r.associated_data, 'utf8'));
      d.setAuthTag(tag);
      plain = Buffer.concat([d.update(cipher), d.final()]).toString('utf8');
    } catch {
      return fail('回调解密失败(APIv3 密钥不符?)');
    }
    const obj = JSON.parse(plain) as Record<string, unknown>;

    const et = evt.event_type ?? '';
    if (et === 'TRANSACTION.SUCCESS') {
      const amount = obj.amount as { total?: number } | undefined;
      return {
        ok: true,
        event: 'payment',
        outTradeNo: String(obj.out_trade_no ?? ''),
        txnId: String(obj.transaction_id ?? ''),
        paidAmountFen: amount?.total,
        paidAt: obj.success_time ? Date.parse(String(obj.success_time)) : undefined,
        ack: ACK_OK,
      };
    }
    if (et.startsWith('REFUND.')) {
      const amount = obj.amount as { refund?: number } | undefined;
      return {
        ok: true,
        event: 'refund',
        outTradeNo: String(obj.out_trade_no ?? ''),
        refundNo: String(obj.out_refund_no ?? ''),
        refundStatus: obj.refund_status === 'SUCCESS' ? 'succeeded' : 'failed',
        refundAmountFen: amount?.refund,
        ack: ACK_OK,
      };
    }
    return { ok: true, event: 'ignored', ack: ACK_OK }; // 无关事件:验签通过即应答,不重试
  }

  // ── 对账单(T+1 交易账单,CSV;字段前有反引号防 Excel 截断,解析时剥掉)──
  async downloadBill(billDate: string): Promise<BillRow[]> {
    const meta = await this.request('GET', `/v3/bill/tradebill?bill_date=${billDate}&bill_type=ALL`);
    if (meta.status !== 200) {
      const e = WechatProvider.errOf(meta.text);
      if (e.code === 'NO_STATEMENT_EXIST' || e.code === 'NOT_FOUND') throw new BillNotReadyError();
      throw new PaymentError('UPSTREAM', `微信账单获取失败(${meta.status}): ${e.message ?? ''}`);
    }
    const { download_url } = JSON.parse(meta.text) as { download_url: string };
    const u = new URL(download_url);
    const dl = await this.request('GET', u.pathname + u.search, undefined, u.origin);
    if (dl.status !== 200) throw new PaymentError('UPSTREAM', `微信账单下载失败(${dl.status})`);
    return WechatProvider.parseBillCsv(dl.text);
  }

  /**
   * 按表头名定位列(防列序变化);数据行每字段以 ` 开头。汇总段(总交易单数…)自然被表头缺列过滤。
   *
   * 金额列名护栏(评审 CRITICAL):v3 交易账单用「订单金额 / 应结订单金额」,v2 才叫「总金额」。
   * 早期实现只认「总金额」→ v3 账单下 iAmount=-1 → 每行金额 0 → 对账把每一笔成功单都判成
   * amount_mismatch(告警风暴 + 对账失效)。这里按 精确「订单金额」→「应结订单金额」→ v2「总金额」
   * 依次定位;三者全无 → 抛协议错误(recon 标 error 重试),绝不静默按 0 处理。
   * 注意用精确匹配:includes('订单金额') 会先撞上「应结订单金额」「申请退款金额」。
   */
  static parseBillCsv(csv: string): BillRow[] {
    const lines = csv.split('\n').filter((l) => l.trim());
    if (lines.length < 2) return [];
    const header = lines[0]!.split(',').map((s) => s.trim().replace(/^`/, ''));
    const exact = (name: string) => header.findIndex((hh) => hh === name);
    const idx = (name: string) => header.findIndex((hh) => hh.includes(name));
    const iOtn = idx('商户订单号');
    const iTxn = header.findIndex((hh) => hh.includes('微信支付订单号') || hh.includes('微信订单号'));
    const iState = idx('交易状态');
    let iAmount = exact('订单金额');
    if (iAmount < 0) iAmount = exact('应结订单金额');
    if (iAmount < 0) iAmount = exact('总金额'); // v2 遗留
    if (iOtn < 0 || iState < 0) return [];
    if (iAmount < 0)
      throw new PaymentError('PROTOCOL', '微信账单无法定位金额列(表头变更?)—— 拒绝按 0 对账');
    const rows: BillRow[] = [];
    for (let i = 1; i < lines.length; i++) {
      const cells = lines[i]!.split(',').map((s) => s.trim().replace(/^`/, ''));
      if (cells.length < header.length) continue; // 汇总段/坏行
      const outTradeNo = cells[iOtn] ?? '';
      if (!outTradeNo) continue;
      const state = cells[iState] ?? '';
      let amountFen: number;
      try {
        amountFen = yuanStringToFen(cells[iAmount] || '0');
      } catch {
        continue; // 该行金额不可解析:跳过(账单单边差异会在 missing_channel 现形)
      }
      rows.push({
        outTradeNo,
        txnId: iTxn >= 0 ? (cells[iTxn] ?? '') : '',
        amountFen,
        status: state === 'SUCCESS' ? 'paid' : state === 'REFUND' ? 'refunded' : 'other',
      });
    }
    return rows;
  }
}
