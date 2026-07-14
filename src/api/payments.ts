// 灵镜 API — 在线支付回调(微信/支付宝)。无登录态,安全靠通道验签(决策9/25)。
//
// ┌─ 挂载与传输(决策9)──────────────────────────────────────────────────────┐
// │ server.ts 在 express.json **之前** 挂 /api/payments/notify:               │
// │ 微信 v3 验签需要原始 body 字节(json parser 一碰就废);支付宝是            │
// │ form-urlencoded。这里统一 express.raw 收原始 Buffer,provider 自行解析。    │
// │ ACK 格式由 provider 给出(微信 JSON / 支付宝字面量 success)。              │
// └────────────────────────────────────────────────────────────────────────────┘
// 应答矩阵(决策25):验签失败→通道错误应答(重试);验签通过(含差异已记录)→成功应答;
// 处理中抛异常→5xx/failure(通道重试自愈,applyPaymentSuccess 幂等保证恰一次)。

import { Router, raw, type Request, type Response } from 'express';
import { CHANNELS, getProvider, type PaymentChannel } from '../payments/index.js';
import { applyPaymentSuccess, applyRefundResult, getAttempt } from '../orders/index.js';

export const paymentsNotifyRouter = Router();

// 单一来源:新增通道只改 payments/index.ts 的 CHANNELS,回调路由自动跟上(否则新通道静默 404)。
const CHANNEL_SET = new Set<PaymentChannel>(CHANNELS);

paymentsNotifyRouter.post(
  '/:channel',
  raw({ type: '*/*', limit: '256kb' }),
  async (req: Request, res: Response) => {
    const channel = req.params.channel as PaymentChannel;
    if (!CHANNEL_SET.has(channel)) return res.status(404).json({ error: 'unknown channel' });
    const provider = getProvider(channel);
    if (!provider) {
      // 通道未配置却收到回调:多半是清配置后的迟到通知 —— 回 5xx 让通道稍后重试,
      // 若配置恢复即可正常入账;长期未配则通道自然停止重试,对账兜底。
      return res.status(503).json({ error: 'channel not configured' });
    }
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? '');
    try {
      const n = await provider.verifyNotify(body, req.headers);
      if (!n.ok) {
        console.warn(`[支付][回调] ${channel} 验签失败 ip=${req.ip}`);
        res.status(n.ack.status).type(n.ack.contentType).send(n.ack.body);
        return;
      }
      if (n.event === 'payment' && n.outTradeNo) {
        const outcome = applyPaymentSuccess(
          channel,
          n.outTradeNo,
          n.txnId ?? '',
          n.paidAmountFen ?? -1, // 缺金额按 -1 走金额比对拒绝(落差异表),绝不默认通过
        );
        if (outcome !== 'duplicate')
          console.log(`[支付][回调] ${channel} ${n.outTradeNo} → ${outcome}`);
      } else if (n.event === 'refund' && n.outTradeNo) {
        // 微信退款通知:按 out_trade_no 定位 attempt;refund_no 不符 → 忽略(仍 ACK,防重试风暴)。
        const attempt = getAttempt(n.outTradeNo);
        if (attempt && (!n.refundNo || attempt.refund_no === n.refundNo)) {
          const r = applyRefundResult(attempt.id, n.refundStatus === 'succeeded', n.refundStatus === 'succeeded' ? undefined : '通道退款未成功(见退款通知)');
          console.log(`[支付][回调] ${channel} 退款 ${n.outTradeNo} → ${r}`);
        } else {
          console.warn(`[支付][回调] ${channel} 退款通知无法匹配 attempt=${n.outTradeNo} refundNo=${n.refundNo ?? '-'}`);
        }
      }
      res.status(n.ack.status).type(n.ack.contentType).send(n.ack.body);
    } catch (e) {
      // 处理中异常(DB 等):让通道重试,幂等入账保证恰一次(测试:混沌用例)。
      console.error(`[支付][回调] ${channel} 处理异常(通道将重试):`, e instanceof Error ? e.message : e);
      if (channel === 'alipay') res.status(200).type('text/plain').send('failure');
      else res.status(500).json({ code: 'FAIL', message: 'internal error' });
    }
  },
);
