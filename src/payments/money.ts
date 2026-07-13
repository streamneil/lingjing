// 灵镜 在线支付 — 元↔分换算唯一点(134× 扣费事故护栏,prior learning)。
//
// 订单/套餐以「元」记账(recharge_order.price_yuan INTEGER),微信/支付宝 API 以「分」计。
// 全仓库只允许这里做换算;任何直接 *100 / /100 都是审查红线。
// 护栏:换算结果必须是安全整数正分;非法值抛 PaymentError(拒下单,绝不静默取整)。

import { PaymentError } from './types.js';

export function yuanToFen(yuan: number): number {
  if (typeof yuan !== 'number' || !Number.isFinite(yuan)) {
    throw new PaymentError('AMOUNT_INVALID', '订单金额异常,请联系运营');
  }
  const fen = Math.round(yuan * 100);
  // 四舍五入前后偏差 > 1e-6 说明传入了无法精确表示为「分」的值(如 0.011 元)→ 拒。
  if (Math.abs(yuan * 100 - fen) > 1e-6 || !Number.isSafeInteger(fen) || fen <= 0) {
    throw new PaymentError('AMOUNT_INVALID', '订单金额异常,请联系运营');
  }
  return fen;
}

export function fenToYuan(fen: number): number {
  if (!Number.isSafeInteger(fen) || fen < 0) {
    throw new PaymentError('AMOUNT_INVALID', '金额异常');
  }
  return fen / 100;
}

/** 支付宝金额是「元字符串,两位小数」;同样只在这一个文件里出现。 */
export function fenToYuanString(fen: number): string {
  if (!Number.isSafeInteger(fen) || fen <= 0) {
    throw new PaymentError('AMOUNT_INVALID', '金额异常');
  }
  return (fen / 100).toFixed(2);
}

export function yuanStringToFen(s: string): number {
  const n = Number(s);
  if (!Number.isFinite(n)) throw new PaymentError('AMOUNT_INVALID', '金额异常');
  return yuanToFen(n);
}
