// 灵镜 API — 对公充值订单 + 发票(租户用户侧)。
//
// 决策来源:/plan-design-review + /plan-eng-review(钱路加固)。
//   - 全端点账号隔离:list/get/下载经 scopeByActor(getOrderForActor/getInvoiceForActor),
//     非本人非 admin → 404,不泄露存在性(复用 jobs-download 范式)。
//   - 回单截图上传:multer 内存 + ≤5MB + MIME 白名单(image/png,jpeg);落 storage。
//   - 下载(回单/发票 PDF):先 scopeByActor 取行校验归属(404)再 getObject 流式回传,
//     Content-Disposition: attachment(同源,无 CORS)。
//   - 状态迁移全在 orders/index.ts 单一原子来源,本层只调用 + 鉴权 + 审计。

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { putObject, getObject } from '../storage/index.js';
import { audit } from '../audit/index.js';
import {
  createOrder,
  getOrderForActor,
  listOrdersForActor,
  claimPaid,
  cancelOrderWithAttempt,
  requestInvoice,
  getInvoiceForActor,
  getInvoiceByOrder,
  listInvoicesForActor,
  getInvoiceProfile,
  upsertInvoiceProfile,
  getPayee,
  startPayment,
  checkPaymentNow,
  pendingAttemptForOrder,
  OrderError,
} from '../orders/index.js';
import { availableScenes, CHANNELS, type PaymentChannel, type PaymentScene } from '../payments/index.js';
import { balance } from '../credits/index.js';
import { randomUUID } from 'node:crypto';

export const ordersRouter = Router();

const RECEIPT_MAX = 5 * 1024 * 1024; // 5MB(外部声音 #4)
const RECEIPT_MIME = new Set(['image/png', 'image/jpeg']);
const receiptUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: RECEIPT_MAX },
});

// 409 = 状态冲突(客户端应刷新重试),400 = 请求本身有问题。在线支付的并发/状态冲突同属前者,
// 否则同一类错误在不同端点返回不同码,客户端无法统一处理(评审 api-contract)。
const CONFLICT_CODES = new Set([
  'INVOICE_EXISTS', 'INVOICE_ATTACHED', 'CONCURRENT_PAYMENT', 'ORDER_NOT_PAYABLE',
  'ONLINE_IN_FLIGHT', 'REFUND_IN_FLIGHT', 'ORDER_NOT_REFUNDABLE', 'ATTEMPT_CREDITED_ORDER',
]);

function handleOrderError(e: unknown, res: Response): void {
  if (e instanceof OrderError) {
    const conflict = CONFLICT_CODES.has(e.code);
    res.status(conflict ? 409 : 400).json({ error: e.message, code: e.code });
    return;
  }
  res.status(500).json({ error: '服务异常' });
}

// 对公收款信息(超管后台配置;真实银行账号不进代码)。recharge 页渲染用。
ordersRouter.get('/payee-info', requireAuth, (_req: Request, res: Response) => {
  const p = getPayee();
  res.json({
    payeeName: p.payee_name,
    taxNo: p.tax_no,
    bankName: p.bank_name,
    bankAccount: p.bank_account,
    configured: !!(p.payee_name && p.bank_account),
  });
});

// 收银台可用支付方式(决策6/7:对公 + 每通道分场景开关;未配置的通道前端显「敬请期待」)。
ordersRouter.get('/payment-methods', requireAuth, (_req: Request, res: Response) => {
  const p = getPayee();
  const channels: Record<string, string[]> = {};
  for (const c of CHANNELS) channels[c] = availableScenes(c);
  res.json({ offline: !!(p.payee_name && p.bank_account), channels });
});

// 发起在线支付(决策2A:pending 期可切换通道;服务层关旧码插新码)。
ordersRouter.post('/orders/:id/pay', requireRole('admin', 'creator'), async (req: Request, res: Response) => {
  const o = getOrderForActor(req.params.id!, req.user!.tenantId, req.user!.id, req.user!.role === 'admin');
  if (!o) return res.status(404).json({ error: '订单不存在' });
  const { channel, scene } = (req.body ?? {}) as { channel?: PaymentChannel; scene?: PaymentScene };
  if (!channel || !scene) return res.status(400).json({ error: '缺少支付方式参数' });
  try {
    const r = await startPayment({
      orderId: o.id,
      tenantId: req.user!.tenantId,
      channel,
      scene,
      // req.ip 已由 Express 按 trust proxy=1 解析(取反代追加的最后一跳);直接读 X-Forwarded-For
      // 首段是客户端可伪造的,会把假 IP 报给微信风控。
      clientIp: req.ip || req.socket.remoteAddress || '127.0.0.1',
    });
    if ('alreadyPaid' in r && r.alreadyPaid) return res.json({ alreadyPaid: true });
    audit(req, 'start_payment', `${o.order_no}|${channel}/${scene}`);
    res.json(r);
  } catch (e) {
    if (e instanceof OrderError) return handleOrderError(e, res);
    // 通道上游失败:订单无损,引导重试/换对公(Section 2 错误地图)。
    console.error(`[支付] 下单失败 order=${o.order_no}:`, e instanceof Error ? e.message : e);
    res.status(502).json({ error: '支付下单失败,请重试或改用对公转账' });
  }
});

// 用户触发主动查单(决策8:「我已支付」点击 + H5 返回页)。限流:每单 3s 一次。
const checkPaymentLast = new Map<string, number>();
ordersRouter.post('/orders/:id/check-payment', requireAuth, async (req: Request, res: Response) => {
  const o = getOrderForActor(req.params.id!, req.user!.tenantId, req.user!.id, req.user!.role === 'admin');
  if (!o) return res.status(404).json({ error: '订单不存在' });
  const last = checkPaymentLast.get(o.id) ?? 0;
  if (Date.now() - last < 3000) return res.json({ status: o.status, throttled: true });
  checkPaymentLast.set(o.id, Date.now());
  if (checkPaymentLast.size > 5000) checkPaymentLast.clear(); // 粗粒度防泄漏(限流窗口仅 3s,清空无害)
  try {
    const status = await checkPaymentNow(o.id, req.user!.tenantId);
    res.json({ status });
  } catch (e) {
    if (e instanceof OrderError) return handleOrderError(e, res);
    res.json({ status: o.status, queryFailed: true }); // 通道查单失败:降级返回本地状态,前端继续轮询
  }
});

// 下单(选套餐 → 生成订单)。建单守卫(面议/下架/不存在)在服务层。
ordersRouter.post('/orders', requireRole('admin', 'creator'), (req: Request, res: Response) => {
  const { planId } = (req.body ?? {}) as { planId?: string };
  if (!planId) return res.status(400).json({ error: '缺少套餐 planId' });
  try {
    const o = createOrder({ tenantId: req.user!.tenantId, userId: req.user!.id, planId });
    audit(req, 'create_order', o.order_no);
    res.json({ order: serializeOrder(o) });
  } catch (e) {
    handleOrderError(e, res);
  }
});

// 我的订单台账(账号隔离)。
ordersRouter.get('/orders', requireAuth, (req: Request, res: Response) => {
  const rows = listOrdersForActor(
    req.user!.tenantId,
    req.user!.id,
    req.user!.role === 'admin',
  );
  res.json({ orders: rows.map(serializeOrder), balance: balance(req.user!.tenantId) });
});

// 订单详情(账号隔离;非本人非 admin → 404)。含在途在线支付信息(收银台刷新恢复倒计时/码)。
ordersRouter.get('/orders/:id', requireAuth, (req: Request, res: Response) => {
  const o = getOrderForActor(
    req.params.id!,
    req.user!.tenantId,
    req.user!.id,
    req.user!.role === 'admin',
  );
  if (!o) return res.status(404).json({ error: '订单不存在' });
  const attempt = o.status === 'pending_payment' ? pendingAttemptForOrder(o.id) : undefined;
  res.json({
    order: serializeOrder(o),
    pendingAttempt: attempt
      ? {
          attemptId: attempt.id,
          channel: attempt.channel,
          scene: attempt.scene,
          kind: attempt.scene === 'native' ? 'qr' : 'redirect',
          payload: attempt.code_url,
          expiresAt: attempt.expires_at,
        }
      : null,
  });
});

// 我已完成打款(+可选回单截图)。pending_payment → paid_claimed(rejected 是终态,不可重提)。
ordersRouter.post(
  '/orders/:id/claim-paid',
  requireRole('admin', 'creator'),
  receiptUpload.single('receipt'),
  async (req: Request, res: Response) => {
    // 先校验归属(404 不泄露存在性)
    const o = getOrderForActor(
      req.params.id!,
      req.user!.tenantId,
      req.user!.id,
      req.user!.role === 'admin',
    );
    if (!o) return res.status(404).json({ error: '订单不存在' });

    let receiptKey: string | null = o.receipt_key;
    const file = req.file;
    if (file) {
      if (!RECEIPT_MIME.has(file.mimetype))
        return res.status(400).json({ error: '回单仅支持 PNG / JPEG 图片' });
      receiptKey = `receipts/${req.user!.tenantId}/${o.id}-${randomUUID()}`;
      await putObject(receiptKey, file.buffer, file.mimetype);
    }

    try {
      const ok = claimPaid(o.id, req.user!.tenantId, receiptKey);
      if (!ok) return res.status(409).json({ error: '订单状态不可提交打款' });
    } catch (e) {
      // ONLINE_IN_FLIGHT(决策22 互斥):有在途在线支付时拒绝对公申报。
      if (e instanceof OrderError) return res.status(409).json({ error: e.message, code: e.code });
      throw e;
    }
    audit(req, 'claim_paid', o.order_no);
    res.json({ ok: true });
  },
);

// 取消订单(仅 pending;服务层守卫兑底)。在线单先查单(已付→入账不可取消)再通道关单。
ordersRouter.post('/orders/:id/cancel', requireRole('admin', 'creator'), async (req: Request, res: Response) => {
  const o = getOrderForActor(req.params.id!, req.user!.tenantId, req.user!.id, req.user!.role === 'admin');
  if (!o) return res.status(404).json({ error: '订单不存在' });
  try {
    const r = await cancelOrderWithAttempt(o.id, req.user!.tenantId);
    if (r.credited) return res.status(409).json({ error: '该订单已支付成功,积分已入账,无法取消', code: 'ALREADY_PAID' });
    if (!r.cancelled) return res.status(409).json({ error: '该状态订单不可取消' });
  } catch (e) {
    if (e instanceof OrderError) return handleOrderError(e, res);
    // 通道关单失败:不放行取消(旧码可能仍可支付,防「取消后又被扣款」),让用户稍后重试。
    console.error(`[支付] 取消订单关单失败 order=${o.order_no}:`, e instanceof Error ? e.message : e);
    return res.status(502).json({ error: '取消失败(支付通道暂不可达),请稍后重试' });
  }
  audit(req, 'cancel_order', o.order_no);
  res.json({ ok: true });
});

// 下载回单截图(账号隔离 + 流式)。
ordersRouter.get('/orders/:id/receipt', requireAuth, async (req: Request, res: Response) => {
  const o = getOrderForActor(req.params.id!, req.user!.tenantId, req.user!.id, req.user!.role === 'admin');
  if (!o || !o.receipt_key) return res.status(404).json({ error: '回单不存在' });
  await streamObject(o.receipt_key, `回单-${o.order_no}`, res, true); // inline 预览图片
});

// 订单关联的开票信息(订单页「开票信息」详情用)。账号隔离:先校验订单归属,再反查发票。
ordersRouter.get('/orders/:id/invoice', requireAuth, (req: Request, res: Response) => {
  const o = getOrderForActor(req.params.id!, req.user!.tenantId, req.user!.id, req.user!.role === 'admin');
  if (!o) return res.status(404).json({ error: '订单不存在' });
  const inv = getInvoiceByOrder(o.id, req.user!.tenantId);
  if (!inv) return res.status(404).json({ error: '该订单尚未开票' });
  res.json({ invoice: serializeInvoice(inv) });
});

// ── 发票 ──

// 申请开票(一票多单;仅租户 admin)。首次填抬头自动 upsert 到租户开票资料。
ordersRouter.post('/invoices', requireRole('admin'), (req: Request, res: Response) => {
  const { orderIds, title, taxNo } = (req.body ?? {}) as {
    orderIds?: string[];
    title?: string;
    taxNo?: string;
  };
  if (!Array.isArray(orderIds) || orderIds.length === 0)
    return res.status(400).json({ error: '请至少选择一个订单' });
  try {
    const inv = requestInvoice({
      orderIds,
      tenantId: req.user!.tenantId,
      userId: req.user!.id,
      title: title ?? '',
      taxNo: taxNo ?? '',
    });
    // 抬头资料自动维护到租户(首次填即存;仅 admin 走到这里)。
    upsertInvoiceProfile({
      tenantId: req.user!.tenantId,
      title: (title ?? '').trim(),
      taxNo: (taxNo ?? '').trim(),
      updatedBy: req.user!.id,
    });
    audit(req, 'request_invoice', inv.title);
    res.json({ invoice: serializeInvoice(inv) });
  } catch (e) {
    handleOrderError(e, res);
  }
});

// 租户开票抬头资料:GET 所有登录用户可读(预填);PUT 仅 admin 可编辑。
ordersRouter.get('/invoice-profile', requireAuth, (req: Request, res: Response) => {
  const p = getInvoiceProfile(req.user!.tenantId);
  res.json({ profile: p ?? null });
});
ordersRouter.put('/invoice-profile', requireRole('admin'), (req: Request, res: Response) => {
  const { title, taxNo, bankName, bankAccount, address, phone } = (req.body ?? {}) as Record<
    string,
    string
  >;
  if (!title?.trim() || !taxNo?.trim())
    return res.status(400).json({ error: '抬头和税号必填' });
  upsertInvoiceProfile({
    tenantId: req.user!.tenantId,
    title: title.trim(),
    taxNo: taxNo.trim(),
    bankName: bankName?.trim(),
    bankAccount: bankAccount?.trim(),
    address: address?.trim(),
    phone: phone?.trim(),
    updatedBy: req.user!.id,
  });
  audit(req, 'update_invoice_profile', title.trim());
  res.json({ ok: true });
});

// 我的发票台账(账号隔离)。
ordersRouter.get('/invoices', requireAuth, (req: Request, res: Response) => {
  const rows = listInvoicesForActor(req.user!.tenantId, req.user!.id, req.user!.role === 'admin');
  res.json({ invoices: rows.map(serializeInvoice) });
});

// 下载发票 PDF(账号隔离 + 流式)。
ordersRouter.get('/invoices/:id/pdf', requireAuth, async (req: Request, res: Response) => {
  const inv = getInvoiceForActor(req.params.id!, req.user!.tenantId, req.user!.id, req.user!.role === 'admin');
  if (!inv || !inv.pdf_key) return res.status(404).json({ error: '发票不存在或未开具' });
  await streamObject(inv.pdf_key, `发票-${inv.invoice_no ?? inv.id}`, res);
});

// ── helpers ──

// inline=true:浏览器内预览(回执图片用,按 magic bytes 判图片 Content-Type);否则 attachment 下载。
async function streamObject(key: string, filename: string, res: Response, inline = false): Promise<void> {
  let buf: Buffer;
  try {
    buf = await getObject(key);
  } catch {
    res.status(404).json({ error: '文件不存在' });
    return;
  }
  if (inline) {
    const mime =
      buf[0] === 0x89 && buf[1] === 0x50 ? 'image/png'
      : buf[0] === 0xff && buf[1] === 0xd8 ? 'image/jpeg'
      : 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', 'inline');
  } else {
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  }
  res.setHeader('Cache-Control', 'private, max-age=0, no-store');
  res.send(buf);
}

function serializeOrder(o: ReturnType<typeof getOrderForActor> & object) {
  return {
    id: o!.id,
    orderNo: o!.order_no,
    planName: o!.plan_name,
    priceYuan: o!.price_yuan,
    credits: o!.credits,
    bonusCredits: o!.bonus_credits,
    status: o!.status,
    paymentMethod: o!.payment_method, // offline_bank|wechat|alipay;pending 期可切换,支付成功/claimPaid 锁定
    actorName: o!.actorName ?? null, // 发起人(admin 看全机构时显谁下的单;creator 自己的单为自己)
    invoiceStatus: o!.invoiceStatus ?? null, // 开票状态(未开/requested/issued;派生)
    hasReceipt: !!o!.receipt_key,
    adminNote: o!.admin_note,
    createdAt: o!.created_at,
  };
}

function serializeInvoice(inv: ReturnType<typeof getInvoiceForActor> & object) {
  return {
    id: inv!.id,
    orderIds: inv!.orderIds ?? [], // 一票多单(走 invoice_order)
    orderNos: inv!.orderNos ?? [],
    title: inv!.title,
    taxNo: inv!.tax_no,
    kind: inv!.kind,
    amountYuan: inv!.amount_yuan,
    status: inv!.status,
    invoiceNo: inv!.invoice_no,
    hasPdf: !!inv!.pdf_key,
    createdAt: inv!.created_at,
  };
}
