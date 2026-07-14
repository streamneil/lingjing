// 灵镜 在线支付 — 通道抽象层类型(设计:docs/designs/online-payments.md)。
//
// PaymentProvider 是唯一的通道形状:微信/支付宝各自实现,orders/recon 只面向接口。
// 金额一律「整数分」(fen);元↔分换算收敛在 money.ts 唯一点(134× 事故护栏)。

import type { PaymentChannel, PaymentScene } from '../db/index.js';

export type { PaymentChannel, PaymentScene };

/** 通道层业务错误(API 层透传 4xx;code 供前端/测试断言)。 */
export class PaymentError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface CreatePaymentInput {
  attemptId: string; // = out_trade_no(32 hex)
  amountFen: number;
  description: string; // 商品描述(套餐名)
  clientIp: string; // H5 场景微信要求真实客户端 IP
  scene: PaymentScene;
  notifyUrl: string;
  returnUrl: string; // H5/wap 支付完成返回页(支付宝 return_url/quit_url;微信 H5 场景引导返回)
  expiresAt: number; // 绝对过期时刻(ms);通道侧 time_expire 与本地 attempt 对齐(决策24)
}

/** kind 区分「二维码内容」(前端画码)与「浏览器跳转」(location.href)。 */
export interface CreatePaymentResult {
  kind: 'qr' | 'redirect';
  payload: string;
}

// refunded:通道侧已退款(含运营在商户后台手工退的)。绝不能当 paid 入账 —— 否则
// 「钱已退回买家、积分照发」。查单路径必须把它与 paid 区分开。
export type ChannelOrderStatus = 'not_found' | 'pending' | 'paid' | 'closed' | 'refunded';

export interface QueryResult {
  status: ChannelOrderStatus;
  txnId?: string;
  paidAmountFen?: number;
  paidAt?: number;
}

/** 回调验签结果。ok=false 即验签/解密失败(调用方按通道 ack 回错)。
 *  ack 由 provider 给出通道正确应答(微信 JSON / 支付宝字面量 success,决策9)。 */
export interface NotifyResult {
  ok: boolean;
  event: 'payment' | 'refund' | 'ignored'; // ignored:验签通过但事件类型无关(如退款关闭以外的事件)
  outTradeNo?: string;
  txnId?: string;
  paidAmountFen?: number;
  paidAt?: number;
  refundNo?: string;
  refundStatus?: 'succeeded' | 'failed';
  refundAmountFen?: number;
  ack: { status: number; body: string; contentType: string };
}

export interface RefundInput {
  attemptId: string; // 原支付单 out_trade_no
  txnId: string; // 通道交易号
  refundNo: string; // out_refund_no
  amountFen: number; // 整单全额(v1)
  reason: string;
  notifyUrl: string; // 微信退款结果异步通知
}

export type RefundResult =
  | { status: 'processing' } // 微信:受理成功,结果走异步通知
  | { status: 'succeeded' } // 支付宝:同步确认
  | { status: 'failed'; reason: string };

/** 对账单归一行(downloadBill 返回;recon 与本地 payment_attempt 对平)。 */
export interface BillRow {
  outTradeNo: string;
  txnId: string;
  amountFen: number;
  status: 'paid' | 'refunded' | 'other';
}

/** 账单尚未生成(T+1 太早)→ recon 顺延重试,不算失败。 */
export class BillNotReadyError extends Error {
  constructor(msg = '对账单尚未生成') {
    super(msg);
  }
}

export interface PaymentProvider {
  channel: PaymentChannel;
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  queryPayment(attemptId: string): Promise<QueryResult>;
  verifyNotify(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<NotifyResult>;
  /** 幂等:已关/不存在不抛。 */
  closePayment(attemptId: string): Promise<void>;
  refund(input: RefundInput): Promise<RefundResult>;
  /** 对账单(T+1)。未生成抛 BillNotReadyError。 */
  downloadBill(billDate: string): Promise<BillRow[]>;
}
