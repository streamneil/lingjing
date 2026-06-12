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
  cancelOrder,
  requestInvoice,
  getInvoiceForActor,
  listInvoicesForActor,
  getPayee,
  OrderError,
} from '../orders/index.js';
import { balance } from '../credits/index.js';
import { randomUUID } from 'node:crypto';

export const ordersRouter = Router();

const RECEIPT_MAX = 5 * 1024 * 1024; // 5MB(外部声音 #4)
const RECEIPT_MIME = new Set(['image/png', 'image/jpeg']);
const receiptUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: RECEIPT_MAX },
});

function handleOrderError(e: unknown, res: Response): void {
  if (e instanceof OrderError) {
    // 409 用于「已申请开票」等冲突,其余 400。
    const conflict = e.code === 'INVOICE_EXISTS';
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

// 订单详情(账号隔离;非本人非 admin → 404)。
ordersRouter.get('/orders/:id', requireAuth, (req: Request, res: Response) => {
  const o = getOrderForActor(
    req.params.id!,
    req.user!.tenantId,
    req.user!.id,
    req.user!.role === 'admin',
  );
  if (!o) return res.status(404).json({ error: '订单不存在' });
  res.json({ order: serializeOrder(o) });
});

// 我已完成打款(+可选回单截图)。pending|rejected → paid_claimed。
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

    const ok = claimPaid(o.id, req.user!.tenantId, receiptKey);
    if (!ok) return res.status(409).json({ error: '订单状态不可提交打款' });
    audit(req, 'claim_paid', o.order_no);
    res.json({ ok: true });
  },
);

// 取消订单(仅 pending|rejected;服务层守卫兑底)。
ordersRouter.post('/orders/:id/cancel', requireRole('admin', 'creator'), (req: Request, res: Response) => {
  const o = getOrderForActor(req.params.id!, req.user!.tenantId, req.user!.id, req.user!.role === 'admin');
  if (!o) return res.status(404).json({ error: '订单不存在' });
  const ok = cancelOrder(o.id, req.user!.tenantId);
  if (!ok) return res.status(409).json({ error: '该状态订单不可取消' });
  audit(req, 'cancel_order', o.order_no);
  res.json({ ok: true });
});

// 下载回单截图(账号隔离 + 流式)。
ordersRouter.get('/orders/:id/receipt', requireAuth, async (req: Request, res: Response) => {
  const o = getOrderForActor(req.params.id!, req.user!.tenantId, req.user!.id, req.user!.role === 'admin');
  if (!o || !o.receipt_key) return res.status(404).json({ error: '回单不存在' });
  await streamObject(o.receipt_key, `回单-${o.order_no}`, res);
});

// ── 发票 ──

// 去开票(仅 credited 订单;归属/状态/重复校验在服务层)。
ordersRouter.post('/invoices', requireRole('admin', 'creator'), (req: Request, res: Response) => {
  const { orderId, title, taxNo } = (req.body ?? {}) as {
    orderId?: string;
    title?: string;
    taxNo?: string;
  };
  if (!orderId) return res.status(400).json({ error: '缺少订单' });
  try {
    const inv = requestInvoice({
      orderId,
      tenantId: req.user!.tenantId,
      userId: req.user!.id,
      title: title ?? '',
      taxNo: taxNo ?? '',
    });
    audit(req, 'request_invoice', inv.title); // 抬头(用户可识别),非 UUID
    res.json({ invoice: serializeInvoice(inv) });
  } catch (e) {
    handleOrderError(e, res);
  }
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

async function streamObject(key: string, filename: string, res: Response): Promise<void> {
  let buf: Buffer;
  try {
    buf = await getObject(key);
  } catch {
    res.status(404).json({ error: '文件不存在' });
    return;
  }
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
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
    paymentMethod: o!.payment_method, // 本轮恒 offline_bank;前端映射「对公账户转账」
    actorName: o!.actorName ?? null, // 发起人(admin 看全机构时显谁下的单;creator 自己的单为自己)
    hasReceipt: !!o!.receipt_key,
    adminNote: o!.admin_note,
    createdAt: o!.created_at,
  };
}

function serializeInvoice(inv: ReturnType<typeof getInvoiceForActor> & object) {
  return {
    id: inv!.id,
    orderId: inv!.order_id,
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
