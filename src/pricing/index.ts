// 灵镜 定价套餐 + 意向线索服务 — 套餐 CRUD/排序 + 线索落库/流转。
//
// 决策来源:/plan-design-review(展示价+咨询式)+ /plan-eng-review。
//   - 套餐由 admin 后台动态管理(代码不写死),前端定价区只渲染。照 image_model_override 范式。
//   - 校验单一来源(eng-review CodeQuality#4):所有校验在本层 createPlan/updatePlan,
//     admin 路由只调用 —— 租户读路径与 admin 写路径不重复、不漂移。
//   - 咨询式购买:点击落 sales_leads(user_id + 套餐快照),不接支付。运营确认付款后手动 grant。
//
// ┌─ 线索 kind 分支(createLead)──────────────────────────────┐
// │ plan:       planId 必填且套餐存在且 enabled → 落套餐快照     │
// │ enterprise: planId 必须空 + note 必填(否则无信号)→ 快照 null │
// │ topup:      同 enterprise(自定义扩容,note 带金额/诉求)      │
// └─────────────────────────────────────────────────────────────┘

import { randomUUID } from 'node:crypto';
import {
  db,
  type PricingPlanRow,
  type SalesLeadRow,
  type LeadKind,
  type LeadStatus,
} from '../db/index.js';

const now = () => Date.now();

const LEAD_STATUSES: LeadStatus[] = ['new', 'contacted', 'closed'];
const LEAD_KINDS: LeadKind[] = ['plan', 'enterprise', 'topup'];

/** 业务校验错误(带 code,API 层透传 400)。 */
export class PricingError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// ── 套餐 ──

export interface PlanInput {
  name: string;
  priceYuan: number | null; // null = 面议
  credits: number;
  bonusCredits?: number;
  validityMonths?: number;
  features?: string[];
  flag?: string | null;
  enabled?: boolean;
}

/** 校验单一来源:create / update 都走这里。坏值抛 PricingError(API 层 400)。 */
function validatePlan(input: PlanInput): void {
  if (!input.name || !input.name.trim()) throw new PricingError('NAME_REQUIRED', '套餐名不能为空');
  // price_yuan:null=面议(合法)或正整数。
  if (input.priceYuan !== null) {
    if (!Number.isInteger(input.priceYuan) || input.priceYuan <= 0)
      throw new PricingError('BAD_PRICE', '价格需为正整数,或留空表示面议');
  }
  if (!Number.isInteger(input.credits) || input.credits <= 0)
    throw new PricingError('BAD_CREDITS', '积分数需为正整数');
  const bonus = input.bonusCredits ?? 0;
  if (!Number.isInteger(bonus) || bonus < 0)
    throw new PricingError('BAD_BONUS', '赠送积分需为非负整数');
  const months = input.validityMonths ?? 12;
  if (!Number.isInteger(months) || months < 1)
    throw new PricingError('BAD_VALIDITY', '有效期需为 ≥1 的整数月');
}

/** 列套餐。enabledOnly=true 只返启用(前台);否则全列(admin)。按 sort_order, rowid 排序。 */
export function listPlans(opts: { enabledOnly?: boolean } = {}): PricingPlanRow[] {
  const where = opts.enabledOnly ? 'WHERE enabled = 1' : '';
  return db
    .prepare(`SELECT * FROM pricing_plan ${where} ORDER BY sort_order, rowid`)
    .all() as PricingPlanRow[];
}

export function getPlan(id: string): PricingPlanRow | undefined {
  return db.prepare(`SELECT * FROM pricing_plan WHERE id = ?`).get(id) as PricingPlanRow | undefined;
}

export function createPlan(input: PlanInput): PricingPlanRow {
  validatePlan(input);
  const id = randomUUID();
  const t = now();
  // 新套餐排到末尾(当前最大 sort_order + 1)。
  const maxRow = db.prepare(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM pricing_plan`).get() as {
    m: number;
  };
  db.prepare(
    `INSERT INTO pricing_plan
       (id, name, price_yuan, credits, bonus_credits, validity_months, features, flag, enabled, sort_order, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    input.name.trim(),
    input.priceYuan,
    input.credits,
    input.bonusCredits ?? 0,
    input.validityMonths ?? 12,
    input.features ? JSON.stringify(input.features) : null,
    input.flag ?? null,
    input.enabled === false ? 0 : 1,
    maxRow.m + 1,
    t,
  );
  return getPlan(id)!;
}

export function updatePlan(id: string, input: PlanInput): boolean {
  validatePlan(input);
  const res = db
    .prepare(
      `UPDATE pricing_plan SET
         name=?, price_yuan=?, credits=?, bonus_credits=?, validity_months=?,
         features=?, flag=?, enabled=?
       WHERE id=?`,
    )
    .run(
      input.name.trim(),
      input.priceYuan,
      input.credits,
      input.bonusCredits ?? 0,
      input.validityMonths ?? 12,
      input.features ? JSON.stringify(input.features) : null,
      input.flag ?? null,
      input.enabled === false ? 0 : 1,
      id,
    );
  return res.changes === 1;
}

export function deletePlan(id: string): boolean {
  return db.prepare(`DELETE FROM pricing_plan WHERE id=?`).run(id).changes === 1;
}

/** 按传入有序 id 重写 sort_order(照 image-models reorder 范式)。事务保证全或无。 */
export const reorderPlans = db.transaction((orderedIds: string[]): void => {
  orderedIds.forEach((id, i) => {
    db.prepare(`UPDATE pricing_plan SET sort_order=? WHERE id=?`).run(i, id);
  });
});

/** 把 features JSON 列解析为数组(坏数据 → [])。前端读路径用。 */
export function parseFeatures(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const a = JSON.parse(raw);
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
}

// ── 意向线索 ──

export interface LeadInput {
  tenantId: string;
  userId: string;
  planId: string | null;
  kind: LeadKind;
  note?: string | null;
}

const DEDUP_WINDOW_MS = 60_000; // 同 (user,plan,kind) 60s 内去重(不过滤 status,eng-review 修正)

/**
 * 落一条线索。
 * - kind=plan:planId 必填且套餐存在且 enabled → 落套餐快照。
 * - kind=enterprise/topup:planId 必须空 + note 必填 → 快照字段全 null。
 * 幂等:同 (user_id, plan_id, kind) 60s 内已有线索 → 返已有(不重复落库)。
 */
export function createLead(input: LeadInput): SalesLeadRow {
  if (!LEAD_KINDS.includes(input.kind)) throw new PricingError('BAD_KIND', '无效线索类型');

  let snapshot: Pick<
    SalesLeadRow,
    'plan_name' | 'plan_price_yuan' | 'plan_credits' | 'plan_bonus_credits'
  > = { plan_name: null, plan_price_yuan: null, plan_credits: null, plan_bonus_credits: null };

  if (input.kind === 'plan') {
    if (!input.planId) throw new PricingError('PLAN_REQUIRED', '套餐购买必须指定套餐');
    const plan = getPlan(input.planId);
    if (!plan || plan.enabled !== 1)
      throw new PricingError('PLAN_NOT_FOUND', '套餐不存在或已下架');
    snapshot = {
      plan_name: plan.name,
      plan_price_yuan: plan.price_yuan,
      plan_credits: plan.credits,
      plan_bonus_credits: plan.bonus_credits,
    };
  } else {
    // enterprise / topup:不能带 planId,note 必填(否则线索无信号)。
    if (input.planId) throw new PricingError('NO_PLAN_ALLOWED', '该类型线索不应关联套餐');
    if (!input.note || !input.note.trim())
      throw new PricingError('NOTE_REQUIRED', '请填写需求/金额');
  }

  // 幂等窗口:同 user+plan+kind 近 60s 已有线索 → 返已有。planId 为 null 时按 IS NULL 匹配。
  const since = now() - DEDUP_WINDOW_MS;
  const existing = (
    input.planId
      ? db
          .prepare(
            `SELECT * FROM sales_leads
             WHERE user_id=? AND plan_id=? AND kind=? AND created_at >= ?
             ORDER BY created_at DESC LIMIT 1`,
          )
          .get(input.userId, input.planId, input.kind, since)
      : db
          .prepare(
            `SELECT * FROM sales_leads
             WHERE user_id=? AND plan_id IS NULL AND kind=? AND created_at >= ?
             ORDER BY created_at DESC LIMIT 1`,
          )
          .get(input.userId, input.kind, since)
  ) as SalesLeadRow | undefined;
  if (existing) return existing;

  const id = randomUUID();
  db.prepare(
    `INSERT INTO sales_leads
       (id, tenant_id, user_id, plan_id, plan_name, plan_price_yuan, plan_credits, plan_bonus_credits, kind, note, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,'new',?)`,
  ).run(
    id,
    input.tenantId,
    input.userId,
    input.planId,
    snapshot.plan_name,
    snapshot.plan_price_yuan,
    snapshot.plan_credits,
    snapshot.plan_bonus_credits,
    input.kind,
    input.note?.trim() ?? null,
    now(),
  );
  return db.prepare(`SELECT * FROM sales_leads WHERE id=?`).get(id) as SalesLeadRow;
}

export function listLeads(opts: { status?: LeadStatus; limit?: number } = {}): SalesLeadRow[] {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
  // LEFT JOIN 解析租户名/发起人名(运营要知道「谁的机构、哪个人」在申请扩容,
  // 裸 user_id 对人不可读);租户/用户被删时回退显 ID,线索不丢。
  const base = `
    SELECT l.*, t.name AS tenantName, COALESCE(u.display_name, u.username) AS userName
      FROM sales_leads l
      LEFT JOIN tenant t ON t.id = l.tenant_id
      LEFT JOIN user u ON u.id = l.user_id`;
  return (
    opts.status
      ? db
          .prepare(`${base} WHERE l.status=? ORDER BY l.created_at DESC, l.rowid DESC LIMIT ?`)
          .all(opts.status, limit)
      : db.prepare(`${base} ORDER BY l.created_at DESC, l.rowid DESC LIMIT ?`).all(limit)
  ) as SalesLeadRow[];
}

/** 改线索状态(+ 可选备注)。运营流转 new → contacted → closed。 */
export function updateLeadStatus(id: string, status: LeadStatus, note?: string): boolean {
  if (!LEAD_STATUSES.includes(status)) throw new PricingError('BAD_STATUS', '无效状态');
  const res =
    note !== undefined
      ? db.prepare(`UPDATE sales_leads SET status=?, note=? WHERE id=?`).run(status, note, id)
      : db.prepare(`UPDATE sales_leads SET status=? WHERE id=?`).run(status, id);
  return res.changes === 1;
}

/** 某状态线索计数(admin 监控「new 待跟进」用,单查询不拉全表)。 */
export function countLeadsByStatus(status: LeadStatus): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM sales_leads WHERE status=?`)
    .get(status) as { n: number };
  return row.n;
}

// ── 默认套餐种子(部署开箱即用)──
// 新部署 pricing_plan 为空 → 定价区/落地页无套餐。这里固化一份默认套餐,
// 由 seed 脚本调用灌入;运营之后在 /admin 自行改价/增删。
// 幂等:表非空即跳过(不覆盖运营已改的套餐)。
const DEFAULT_PLANS: PlanInput[] = [
  { name: '入门体验', priceYuan: 100, credits: 800, bonusCredits: 0, features: ['适合个人试用', '约 13 条数字人视频'] },
  { name: '标准充值', priceYuan: 500, credits: 4500, bonusCredits: 300, flag: '最受欢迎', features: ['含赠送积分 300', '团队日常创作'] },
  { name: '专业充值', priceYuan: 1000, credits: 8300, bonusCredits: 600, features: ['含赠送积分 600', '高频生产'] },
  { name: '大富翁', priceYuan: 5000, credits: 42000, bonusCredits: 4500, features: ['含赠送积分 4500', '机构批量采购'] },
];

/** 灌默认套餐。返回新建数量(表非空时返回 0,不重复灌、不覆盖)。 */
export function seedDefaultPlans(): number {
  const existing = (db.prepare(`SELECT COUNT(*) AS n FROM pricing_plan`).get() as { n: number }).n;
  if (existing > 0) return 0; // 已有套餐(运营可能已改),不动
  for (const p of DEFAULT_PLANS) createPlan(p);
  return DEFAULT_PLANS.length;
}
