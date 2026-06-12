// 灵镜 API — 定价套餐(租户读)+ 意向线索(咨询式购买落库,不接支付)。
//
// 决策来源:/plan-design-review + /plan-eng-review。
//   - GET /api/pricing-plans:requireAuth(非公开读 —— billing.html 在登录后,
//     用现有 LJ.get 拉,未登录跳登录是正确行为;eng-review CRITICAL)。只返启用套餐。
//   - POST /api/sales-leads:requireAuth。kind=plan 需 planId;enterprise/topup 需 note、禁 planId。
//     校验/快照/60s 幂等全在 pricing/index.ts(单一来源)。

import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { listPlans, parseFeatures, createLead, PricingError } from '../pricing/index.js';
import type { LeadKind } from '../db/index.js';
import { audit } from '../audit/index.js';

export const pricingRouter = Router();

const CONTACT_TEXT =
  '已记录你的购买意向,平台对接人会尽快与你确认采购合同与开票事宜。如需加急可联系你的客户成功经理。';

/** 列启用套餐(前台定价区)。features 解析为数组,price_yuan null=面议透传给前端。 */
pricingRouter.get('/pricing-plans', requireAuth, (_req: Request, res: Response) => {
  const plans = listPlans({ enabledOnly: true }).map((p) => ({
    id: p.id,
    name: p.name,
    priceYuan: p.price_yuan, // null = 面议
    credits: p.credits,
    bonusCredits: p.bonus_credits,
    validityMonths: p.validity_months,
    features: parseFeatures(p.features),
    flag: p.flag,
  }));
  res.json({ plans });
});

/** 落一条意向线索。点「购买」(plan)/「申请扩容」(topup)/「企业定制」(enterprise)。 */
pricingRouter.post('/sales-leads', requireAuth, (req: Request, res: Response) => {
  const { planId, kind, note } = (req.body ?? {}) as {
    planId?: string;
    kind?: LeadKind;
    note?: string;
  };
  if (!kind) return res.status(400).json({ error: '缺少 kind' });
  try {
    const lead = createLead({
      tenantId: req.user!.tenantId,
      userId: req.user!.id,
      planId: planId ?? null,
      kind,
      note: note ?? null,
    });
    audit(req, 'sales_lead_create', lead.plan_id ?? kind);
    return res.status(201).json({ ok: true, leadId: lead.id, contact: CONTACT_TEXT });
  } catch (e) {
    if (e instanceof PricingError) {
      return res.status(400).json({ error: e.message, code: e.code });
    }
    return res.status(400).json({ error: e instanceof Error ? e.message : '提交失败' });
  }
});
