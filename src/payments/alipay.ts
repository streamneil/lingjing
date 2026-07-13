// 灵镜 在线支付 — 支付宝 Provider(RSA2 普通公钥模式,决策14;公钥证书模式 NOT in scope)。
//
// ┌─ 形态差异(通道层抹平)────────────────────────────────────────────────────────┐
// │ 下单:  签名 GET URL 跳转(page=电脑网站 / wap=手机网站),非二维码 → kind='redirect' │
// │ 回调:  form-urlencoded + RSA2 验签,ACK = 字面量 'success' 文本(决策9)              │
// │ 退款:  alipay.trade.refund **同步**返回(fund_change='Y' 即成功),无异步通知          │
// │ 账单:  downloadurl.query → ZIP(GBK CSV)→ 内置 EOCD 解包 + TextDecoder('gbk')        │
// └─────────────────────────────────────────────────────────────────────────────────┘
// 金额:对外「元字符串两位小数」,对内一律整数分(money.ts 唯一换算点)。

import { createSign, createVerify } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
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
import { fenToYuanString, yuanStringToFen } from './money.js';

export interface AlipayConfig {
  appId: string;
  alipayPublicKeyPem: string; // 支付宝公钥(验签回调/响应;非敏感)
  gateway: string; // 默认 https://openapi.alipay.com/gateway.do
  privateKeyPem: string; // 应用私钥(请求签名;敏感)
}

const ACK_OK = { status: 200, body: 'success', contentType: 'text/plain' };
const ACK_FAIL = { status: 200, body: 'failure', contentType: 'text/plain' };
// 支付宝重试策略按响应体字面量判断('success' 停止),非 2xx 状态码;验签失败也回 200+failure 让其重试。

/** 'yyyy-MM-dd HH:mm:ss'(GMT+8,支付宝 timestamp/time_expire 要求)。 */
function cstDateTime(ms: number): string {
  const d = new Date(ms + 8 * 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

/** RSA2 签名串:按 key 字典序,value 原文(不 URL 编码)拼 k=v&k=v。 */
function signContent(params: Record<string, string>): string {
  return Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
}

export class AlipayProvider implements PaymentProvider {
  readonly channel = 'alipay' as const;
  constructor(private cfg: AlipayConfig) {}

  private commonParams(method: string, bizContent: Record<string, unknown>, extra: Record<string, string> = {}): Record<string, string> {
    const params: Record<string, string> = {
      app_id: this.cfg.appId,
      method,
      format: 'JSON',
      charset: 'utf-8',
      sign_type: 'RSA2',
      timestamp: cstDateTime(Date.now()),
      version: '1.0',
      biz_content: JSON.stringify(bizContent),
      ...extra,
    };
    params.sign = createSign('RSA-SHA256').update(signContent(params), 'utf8').sign(this.cfg.privateKeyPem, 'base64');
    return params;
  }

  private static toQuery(params: Record<string, string>): string {
    return Object.keys(params)
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k]!)}`)
      .join('&');
  }

  /** 服务端 OpenAPI 调用(query/close/refund/bill)。返回 <method>_response 节点 + 原文验签。 */
  private async call(
    method: string,
    bizContent: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const params = this.commonParams(method, bizContent);
    let text: string;
    try {
      const res = await undiciFetch(this.cfg.gateway, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
        body: AlipayProvider.toQuery(params),
        dispatcher: proxyDispatcher('ALIPAY_PROXY'),
        signal: AbortSignal.timeout(15_000),
      });
      text = await res.text();
    } catch (e) {
      throw new PaymentError('UPSTREAM', `支付宝接口不可达: ${e instanceof Error ? e.message : e}`);
    }
    const nodeName = `${method.replace(/\./g, '_')}_response`;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new PaymentError('PROTOCOL', `支付宝响应非 JSON: ${text.slice(0, 200)}`);
    }
    const node = (parsed[nodeName] ?? parsed.error_response) as Record<string, unknown> | undefined;
    if (!node) throw new PaymentError('PROTOCOL', `支付宝响应缺少 ${nodeName}`);
    // 响应验签:对原文中节点 JSON 子串验 RSA2(网关签名防篡改;取子串是官方 SDK 同款做法)。
    const sign = parsed.sign as string | undefined;
    if (sign) {
      const m = text.match(new RegExp(`"${nodeName}"\\s*:\\s*(\\{.*?\\})\\s*,\\s*"sign"`, 's'));
      if (m?.[1]) {
        let ok = false;
        try {
          ok = createVerify('RSA-SHA256').update(m[1], 'utf8').verify(this.cfg.alipayPublicKeyPem, sign, 'base64');
        } catch {
          ok = false;
        }
        if (!ok) throw new PaymentError('SIGNATURE', '支付宝响应验签失败');
      }
    }
    return node;
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const isWap = input.scene === 'wap';
    const biz: Record<string, unknown> = {
      out_trade_no: input.attemptId,
      total_amount: fenToYuanString(input.amountFen),
      subject: input.description,
      product_code: isWap ? 'QUICK_WAP_WAY' : 'FAST_INSTANT_TRADE_PAY',
      time_expire: cstDateTime(input.expiresAt),
    };
    if (isWap) biz.quit_url = input.returnUrl;
    const params = this.commonParams(
      isWap ? 'alipay.trade.wap.pay' : 'alipay.trade.page.pay',
      biz,
      { notify_url: input.notifyUrl, return_url: input.returnUrl },
    );
    // 页面接口不走服务端调用:构造签名 GET URL,前端跳转即拉起收银台。
    return { kind: 'redirect', payload: `${this.cfg.gateway}?${AlipayProvider.toQuery(params)}` };
  }

  async queryPayment(attemptId: string): Promise<QueryResult> {
    const node = await this.call('alipay.trade.query', { out_trade_no: attemptId });
    const code = String(node.code ?? '');
    if (code !== '10000') {
      if (String(node.sub_code ?? '') === 'ACQ.TRADE_NOT_EXIST') return { status: 'not_found' };
      throw new PaymentError('UPSTREAM', `支付宝查单失败(${code}/${node.sub_code ?? ''}): ${node.sub_msg ?? node.msg ?? ''}`);
    }
    const st = String(node.trade_status ?? '');
    if (st === 'TRADE_SUCCESS' || st === 'TRADE_FINISHED') {
      return {
        status: 'paid',
        txnId: String(node.trade_no ?? ''),
        paidAmountFen: node.total_amount ? yuanStringToFen(String(node.total_amount)) : undefined,
        paidAt: node.send_pay_date ? Date.parse(`${String(node.send_pay_date)} GMT+0800`) : undefined,
      };
    }
    if (st === 'TRADE_CLOSED') return { status: 'closed' };
    return { status: 'pending' }; // WAIT_BUYER_PAY
  }

  async closePayment(attemptId: string): Promise<void> {
    const node = await this.call('alipay.trade.close', { out_trade_no: attemptId });
    const code = String(node.code ?? '');
    if (code === '10000') return;
    const sub = String(node.sub_code ?? '');
    if (sub === 'ACQ.TRADE_NOT_EXIST') return; // 用户从未打开收银台 → 通道侧无单,幂等成功
    throw new PaymentError('UPSTREAM', `支付宝关单失败(${code}/${sub}): ${node.sub_msg ?? ''}`);
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const node = await this.call('alipay.trade.refund', {
      out_trade_no: input.attemptId,
      refund_amount: fenToYuanString(input.amountFen),
      out_request_no: input.refundNo,
      refund_reason: input.reason.slice(0, 200),
    });
    const code = String(node.code ?? '');
    // fund_change='Y' 本次真实退款;'N' = 重复请求(此前已退)→ 同样视为成功(幂等)。
    if (code === '10000') return { status: 'succeeded' };
    return { status: 'failed', reason: `支付宝退款被拒(${code}/${node.sub_code ?? ''}): ${node.sub_msg ?? node.msg ?? ''}` };
  }

  // ── 异步通知(form-urlencoded):去 sign/sign_type → 字典序拼串 → RSA2 验签 ──
  async verifyNotify(rawBody: Buffer, _headers: Record<string, string | string[] | undefined>): Promise<NotifyResult> {
    const params: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(rawBody.toString('utf8'))) params[k] = v;
    const sign = params.sign;
    if (!sign) return { ok: false, event: 'ignored', ack: ACK_FAIL };
    const toVerify: Record<string, string> = { ...params };
    delete toVerify.sign;
    delete toVerify.sign_type;
    let verified = false;
    try {
      verified = createVerify('RSA-SHA256')
        .update(signContent(toVerify), 'utf8')
        .verify(this.cfg.alipayPublicKeyPem, sign, 'base64');
    } catch {
      verified = false;
    }
    if (!verified) return { ok: false, event: 'ignored', ack: ACK_FAIL };
    if (params.app_id && params.app_id !== this.cfg.appId)
      return { ok: false, event: 'ignored', ack: ACK_FAIL };

    const st = params.trade_status ?? '';
    if (st === 'TRADE_SUCCESS' || st === 'TRADE_FINISHED') {
      let paidAmountFen: number | undefined;
      try {
        paidAmountFen = params.total_amount ? yuanStringToFen(params.total_amount) : undefined;
      } catch {
        paidAmountFen = undefined; // 金额解析异常 → 交给上层金额比对拒绝
      }
      return {
        ok: true,
        event: 'payment',
        outTradeNo: params.out_trade_no ?? '',
        txnId: params.trade_no ?? '',
        paidAmountFen,
        paidAt: params.gmt_payment ? Date.parse(`${params.gmt_payment} GMT+0800`) : undefined,
        ack: ACK_OK,
      };
    }
    // 关单/退款等其他通知:验签通过即 ACK(支付宝退款是同步确认,不依赖通知)。
    return { ok: true, event: 'ignored', ack: ACK_OK };
  }

  // ── 对账单:downloadurl.query → ZIP(GBK CSV,业务明细)──
  async downloadBill(billDate: string): Promise<BillRow[]> {
    let node: Record<string, unknown>;
    try {
      node = await this.call('alipay.data.dataservice.bill.downloadurl.query', {
        bill_type: 'trade',
        bill_date: billDate,
      });
    } catch (e) {
      throw e;
    }
    const code = String(node.code ?? '');
    if (code !== '10000') {
      const sub = String(node.sub_code ?? '');
      if (sub === 'isp.bill_not_exist' || sub === 'isv.bill-not-exist') throw new BillNotReadyError();
      throw new PaymentError('UPSTREAM', `支付宝账单获取失败(${code}/${sub}): ${node.sub_msg ?? ''}`);
    }
    const url = String(node.bill_download_url ?? '');
    if (!url) throw new PaymentError('PROTOCOL', '支付宝账单返回缺少下载地址');
    let buf: Buffer;
    try {
      const res = await undiciFetch(url, { dispatcher: proxyDispatcher('ALIPAY_PROXY'), signal: AbortSignal.timeout(30_000) });
      buf = Buffer.from(await res.arrayBuffer());
    } catch (e) {
      throw new PaymentError('UPSTREAM', `支付宝账单下载失败: ${e instanceof Error ? e.message : e}`);
    }
    const csv = AlipayProvider.extractBillCsv(buf);
    return AlipayProvider.parseBillCsv(csv);
  }

  /** ZIP 解包(EOCD → 中央目录 → 局部头;store/deflate)。取「业务明细」CSV(排除汇总),GBK 解码。 */
  static extractBillCsv(zip: Buffer): string {
    // EOCD:从尾部找 PK\x05\x06
    let eocd = -1;
    for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65536); i--) {
      if (zip.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new PaymentError('PROTOCOL', '支付宝账单 ZIP 无法解析');
    const count = zip.readUInt16LE(eocd + 10);
    let off = zip.readUInt32LE(eocd + 16);
    const decoder = AlipayProvider.gbkDecoder();
    const entries: { name: string; text: string }[] = [];
    for (let n = 0; n < count; n++) {
      if (zip.readUInt32LE(off) !== 0x02014b50) break;
      const method = zip.readUInt16LE(off + 10);
      const compSize = zip.readUInt32LE(off + 20);
      const nameLen = zip.readUInt16LE(off + 28);
      const extraLen = zip.readUInt16LE(off + 30);
      const commentLen = zip.readUInt16LE(off + 32);
      const localOff = zip.readUInt32LE(off + 42);
      const name = decoder(zip.subarray(off + 46, off + 46 + nameLen));
      // 局部头:数据起点 = localOff + 30 + 局部 nameLen/extraLen(与中央目录可能不同,须重读)。
      const lNameLen = zip.readUInt16LE(localOff + 26);
      const lExtraLen = zip.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const data = zip.subarray(dataStart, dataStart + compSize);
      const raw = method === 8 ? inflateRawSync(data) : Buffer.from(data);
      entries.push({ name, text: decoder(raw) });
      off += 46 + nameLen + extraLen + commentLen;
    }
    const detail = entries.find((e) => e.name.endsWith('.csv') && !e.name.includes('汇总'));
    if (!detail) throw new PaymentError('PROTOCOL', '支付宝账单 ZIP 内未找到明细 CSV');
    return detail.text;
  }

  private static gbkDecoder(): (b: Buffer) => string {
    try {
      const d = new TextDecoder('gbk');
      return (b) => d.decode(b);
    } catch {
      return (b) => b.toString('utf8'); // 无 full-icu 的兜底(官方 Node 构建均带 gbk)
    }
  }

  /** 业务明细 CSV:#号行为注释/汇总;按表头定位 交易号/商户订单号/业务类型/订单金额。 */
  static parseBillCsv(csv: string): BillRow[] {
    const lines = csv.split('\n').map((l) => l.replace(/\r$/, ''));
    const headerIdx = lines.findIndex((l) => l.includes('商户订单号') && !l.startsWith('#'));
    if (headerIdx < 0) return [];
    const header = lines[headerIdx]!.split(',').map((s) => s.trim());
    const idx = (name: string) => header.findIndex((hh) => hh.includes(name));
    const iTxn = idx('交易号');
    const iOtn = idx('商户订单号');
    const iKind = idx('业务类型');
    const iAmount = idx('订单金额');
    if (iOtn < 0) return [];
    const rows: BillRow[] = [];
    for (let i = headerIdx + 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line.trim() || line.startsWith('#')) continue;
      const cells = line.split(',').map((s) => s.trim());
      const outTradeNo = (cells[iOtn] ?? '').trim();
      if (!outTradeNo) continue;
      const kind = iKind >= 0 ? (cells[iKind] ?? '') : '交易';
      let amountFen = 0;
      try {
        amountFen = iAmount >= 0 ? yuanStringToFen((cells[iAmount] || '0').replace(/^-/, '')) : 0;
      } catch {
        continue;
      }
      rows.push({
        outTradeNo,
        txnId: iTxn >= 0 ? (cells[iTxn] ?? '').trim() : '',
        amountFen,
        status: kind.includes('退款') ? 'refunded' : 'paid',
      });
    }
    return rows;
  }
}

