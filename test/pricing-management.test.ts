// 灵镜 — 定价管理:全局倍率 + sellPrice + assertProfitable + 视频取价接倍率。
// 决策来源:ceo-plans/2026-06-16-pricing-management(对抗复审 8/10 PASS)。

import { describe, it, expect, beforeEach } from 'vitest';

process.env.DB_FILE = ':memory:';
const { db } = await import('../src/db/index.js');
const { sellPrice, assertProfitable, setConfig, getConfig, markupX35 } = await import('../src/credits/pricing.js');
const { videoPriceTier } = await import('../src/credits/index.js');
const { getVideoModel } = await import('../src/gateway/video-models.js');
const { seedPlatformDefaults } = await import('../src/seed/platform-defaults.js');

function resetCfg() {
  setConfig('markup_x35', '35');
  setConfig('floor_x35', '10');
}
function clearVov() { db.prepare('DELETE FROM video_model_override').run(); db.prepare('DELETE FROM model_pricing').run(); }
// 2026-06 收口:videoPriceTier 读价从 video_model_override 改到统一表 model_pricing。测试改插统一表。
function insVideoPricing(id: string, modelKey: string, variant: string, cost: number) {
  db.prepare(`INSERT OR REPLACE INTO model_pricing (id,model_key,modality,unit,variant,real_cost_yuan,cost_source,enabled,sort_order,updated_at)
              VALUES (?,?,'video','秒',?,?,'doc',1,0,0)`).run(id, modelKey, variant, cost);
}

describe('sellPrice = ⌈成本 × markup_x35⌉(整数,禁浮点多收)', () => {
  beforeEach(resetCfg);
  it('默认 35:常见成本点不多收', () => {
    expect(sellPrice(0.25)).toBe(9);  // ⌈0.25×35⌉
    expect(sellPrice(0.20)).toBe(7);  // 整数 35 → 7(浮点 0.2×3.5×10=7.0000001→8 是 bug)
    expect(sellPrice(0.50)).toBe(18);
    expect(sellPrice(0.8)).toBe(28);  // 浮点会给 29
    expect(sellPrice(1.6)).toBe(56);  // 浮点会给 57
  });
  it('改全局倍率 → 售价随之变(一改全场重算)', () => {
    setConfig('markup_x35', '40'); // 4.0 倍
    expect(sellPrice(0.5)).toBe(20); // ⌈0.5×40⌉
    setConfig('markup_x35', '30'); // 3.0 倍
    expect(sellPrice(0.5)).toBe(15);
  });
  it('成本无效 → 抛错(绝不静默 floor 到1,防大规模少收)', () => {
    expect(() => sellPrice(0)).toThrow();
    expect(() => sellPrice(-1)).toThrow();
    expect(() => sellPrice(NaN)).toThrow();
  });
});

describe('assertProfitable 三道闸', () => {
  beforeEach(resetCfg);
  it('成本驱动且有效 → 放行', () => {
    expect(() => assertProfitable(0.5, 'doc')).not.toThrow();
  });
  it('estimate 占位价 → 拦', () => {
    expect(() => assertProfitable(0.5, 'estimate')).toThrow(/校准/);
  });
  it('成本缺失且无遗留售价 → 拦', () => {
    expect(() => assertProfitable(null, 'doc')).toThrow(/成本/);
  });
  it('遗留手填售价(无成本但有正 priceTier)→ 放行', () => {
    expect(() => assertProfitable(null, null, 4)).not.toThrow();
  });
  it('全局倍率被改到地板以下 → 拦(CRITICAL:防一改倍率全场赔本)', () => {
    setConfig('markup_x35', '5'); // 0.5 倍,低于地板 10(=1.0倍保本)
    expect(() => assertProfitable(0.5, 'doc')).toThrow(/地板|赔本/);
  });
});

describe('videoPriceTier 接 model_pricing 统一表 + 全局倍率', () => {
  beforeEach(() => { resetCfg(); clearVov(); });
  it('录了真实成本(成本≠回落值)→ sellPrice 算售价(后台可改)', () => {
    insVideoPricing('wan2.7-t2v:720P', 'wan2.7-t2v', '720P', 0.8); // 0.8 ≠ 代码回落 0.6,验证确实读了统一表
    expect(videoPriceTier(getVideoModel('wan2.7-t2v'), '720P', false)).toBe(28); // ⌈0.8×35⌉
  });
  it('改全局倍率 → 视频售价随之变', () => {
    insVideoPricing('wan2.7-t2v:720P', 'wan2.7-t2v', '720P', 0.6);
    setConfig('markup_x35', '40');
    expect(videoPriceTier(getVideoModel('wan2.7-t2v'), '720P', false)).toBe(24); // ⌈0.6×40⌉
  });
  it('无统一表行 → 回落代码常数(迁移前兜底)', () => {
    // 不插行;回落 def.priceTier(代码里 wan2.7-t2v 720P=21)
    expect(videoPriceTier(getVideoModel('wan2.7-t2v'), '720P', false)).toBe(21);
  });
  it('Seedance 2.5 的 480P/720P 与有声价档独立,旧 720P/1080P 分支不变', () => {
    const d = getVideoModel('doubao-seedance-2.5');
    insVideoPricing('doubao-seedance-2.5:480P', d.key, '480P', 0.5);
    insVideoPricing('doubao-seedance-2.5:720P', d.key, '720P', 0.8);
    insVideoPricing('doubao-seedance-2.5:audio-480P', d.key, 'audio-480P', 0.7);
    expect(videoPriceTier(d, '480P', false)).toBe(18);
    expect(videoPriceTier(d, '720P', false)).toBe(28);
    expect(videoPriceTier(d, '480P', true)).toBe(25);

    const wan = getVideoModel('wan2.7-t2v');
    expect(videoPriceTier(wan, '720P', false)).toBe(wan.priceTier);
    expect(videoPriceTier(wan, '1080P', false)).toBe(wan.priceTier1080);
  });
});

describe('Seedance 2.5 默认定价种子', () => {
  beforeEach(() => { resetCfg(); clearVov(); });
  it('种出 480P/720P 及对应有声四个独立变体', () => {
    seedPlatformDefaults();
    const rows = db.prepare(
      `SELECT variant,real_cost_yuan,enabled FROM model_pricing WHERE model_key=? ORDER BY variant`,
    ).all('doubao-seedance-2.5') as Array<{ variant: string; real_cost_yuan: number; enabled: number }>;
    expect(rows.map((r) => r.variant)).toEqual(['480P', '720P', 'audio-480P', 'audio-720P']);
    expect(rows.every((r) => r.real_cost_yuan > 0 && r.enabled === 1)).toBe(true);
  });
});
