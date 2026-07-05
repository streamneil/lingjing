// 灵镜 — 定价单一真源:全局倍率 + 售价计算 + 上架自检闸。
//
// 决策来源:/plan-ceo-review 2026-06-16-pricing-management(对抗复审 8/10 PASS)。
// 核心:售价 = ⌈真实成本元 × markup_x35⌉。markup_x35 是整数(默认35=3.5倍×10积分/元),
//   后台可改但有地板。用整数避免 cost×3.5×10 浮点多收(0.8→29 应28)。
//
// 为什么单独成文件:这是「唯一算价的地方」。estimateImage/Video/Tts 都来这里取价,
//   admin 录成本也来这里换售价。改倍率只改 platform_config 一处,全场售价随之重算。

import { db } from '../db/index.js';

// ── 全局参数(platform_config)──
let _getCfg: import('better-sqlite3').Statement | null = null;
let _setCfg: import('better-sqlite3').Statement | null = null;

/** 读全局参数;不存在返回 undefined(调用方自带兜底)。惰性 prepare(避免早于建表)。 */
export function getConfig(key: string): string | undefined {
  _getCfg ??= db.prepare('SELECT value FROM platform_config WHERE key = ?');
  const row = _getCfg.get(key) as { value: string } | undefined;
  return row?.value;
}

/** 写全局参数(upsert)。 */
export function setConfig(key: string, value: string): void {
  _setCfg ??= db.prepare(
    'INSERT INTO platform_config (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
  );
  _setCfg.run(key, value);
}

/** 当前毛利系数(整数 markup_x35;= 毛利倍率 × 10积分/元)。默认 35。 */
export function markupX35(): number {
  const v = Number(getConfig('markup_x35'));
  return Number.isFinite(v) && v > 0 ? v : 35;
}
/** 倍率地板(整数);markup_x35 不得低于它,否则赔本。默认 10(保本)。 */
export function floorX35(): number {
  const v = Number(getConfig('floor_x35'));
  return Number.isFinite(v) && v > 0 ? v : 10;
}

/**
 * 售价积分 = ⌈真实成本元 × markup_x35⌉。
 * ⚠ 整数系数,禁 cost×3.5×10 浮点(IEEE-754 让 0.8→29、1.6→57 多收1积分)。
 * 复审#2:成本无效(≤0/NaN)抛错,绝不静默 floor 到 1(那是大规模少收)。
 */
export function sellPrice(realCostYuan: number): number {
  if (!(realCostYuan > 0)) throw new Error(`定价失败:真实成本无效(${realCostYuan})`);
  return Math.max(1, Math.ceil(realCostYuan * markupX35()));
}

// ── model_pricing 读价(全模态统一真源)──
// lookupCost 是「唯一读价点」:mergeDef / videoPriceTier / ttsPricePerChar 全经此读 model_pricing → 收口双源。
// pricing.ts 在依赖图上是 db 的叶子(只 import db),lookupCost 放这里不引入环依赖(eng-review 确认)。
let _mpStmt: import('better-sqlite3').Statement | null = null;
export interface PricingLookup {
  id: string;
  realCostYuan: number;
  costSource: string;
  enabled: boolean;
}
/** 变体行 id 拼装唯一点:"{model_key}:{variant}"。图片分档(imagePriceTier/enabledTiers/种子/admin 建档)
 *  全经此拼,改分隔符/大小写只动这里(2026-07 分档计价,DRY)。 */
export function variantId(modelKey: string, variant: string): string {
  return `${modelKey}:${variant}`;
}

/** 读某模型档的统一定价行。id = "{model_key}" 或 variantId(model_key, variant)。无行返回 undefined。
 *  惰性 prepare(绝不在模块顶 prepare,否则早于建表 no-such-table)。 */
export function lookupCost(id: string): PricingLookup | undefined {
  _mpStmt ??= db.prepare('SELECT id, real_cost_yuan, cost_source, enabled FROM model_pricing WHERE id = ?');
  const row = _mpStmt.get(id) as { id: string; real_cost_yuan: number; cost_source: string; enabled: number } | undefined;
  if (!row) return undefined;
  return { id: row.id, realCostYuan: row.real_cost_yuan, costSource: row.cost_source, enabled: row.enabled === 1 };
}

/**
 * 上架自检闸:启用任何可计费模型行前必过。
 * 拦三类赔本/未校准:① 成本驱动行成本≤0 ② estimate 占位价 ③ 全局倍率被改到地板以下。
 * 复审#3(CRITICAL):倍率后台可改,本闸 + 后台保存双拦,防"一改倍率全场集体赔本"。
 *
 * 兼容遗留「手填售价」模型(legacyPriceTier:有正售价但无 realCostYuan)——
 * 这类不是成本驱动,跳过成本/estimate 校验(它的价是人工定的,非自动算),但仍受倍率地板约束。
 */
export function assertProfitable(
  realCostYuan: number | null | undefined,
  costSource: string | null | undefined,
  legacyPriceTier?: number | null,
): void {
  const m = markupX35();
  const floor = floorX35();
  if (m < floor) throw new Error(`全局毛利系数 ${m} < 地板 ${floor},会赔本,拒绝`);
  const isCostDriven = typeof realCostYuan === 'number' && realCostYuan > 0;
  if (isCostDriven) {
    if (costSource === 'estimate') throw new Error('成本未校准(estimate),不能上线');
    return; // 成本驱动且成本有效 → 售价自动算,必达倍率,放行
  }
  // 非成本驱动:允许遗留手填售价(正 priceTier);否则(无成本也无价)拒绝。
  if (typeof legacyPriceTier === 'number' && legacyPriceTier > 0) return;
  throw new Error('成本未录或无效,不能启用');
}
