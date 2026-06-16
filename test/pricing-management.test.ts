// 灵镜 — 定价管理:全局倍率 + sellPrice + assertProfitable + 视频取价接倍率。
// 决策来源:ceo-plans/2026-06-16-pricing-management(对抗复审 8/10 PASS)。

import { describe, it, expect, beforeEach } from 'vitest';

process.env.DB_FILE = ':memory:';
const { db } = await import('../src/db/index.js');
const { sellPrice, assertProfitable, setConfig, getConfig, markupX35 } = await import('../src/credits/pricing.js');
const { videoPriceTier } = await import('../src/credits/index.js');
const { getVideoModel } = await import('../src/gateway/video-models.js');

function resetCfg() {
  setConfig('markup_x35', '35');
  setConfig('floor_x35', '10');
}
function clearVov() { db.prepare('DELETE FROM video_model_override').run(); }

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

describe('videoPriceTier 接 video_model_override + 全局倍率', () => {
  beforeEach(() => { resetCfg(); clearVov(); });
  it('录了真实成本 → sellPrice 算售价(后台可改)', () => {
    db.prepare(`INSERT INTO video_model_override (id,model_key,variant,real_cost_yuan,cost_source,enabled,updated_at) VALUES ('wan2.7-t2v:720P','wan2.7-t2v','720P',0.6,'doc',1,0)`).run();
    expect(videoPriceTier(getVideoModel('wan2.7-t2v'), '720P', false)).toBe(21); // ⌈0.6×35⌉
  });
  it('改全局倍率 → 视频售价随之变', () => {
    db.prepare(`INSERT INTO video_model_override (id,model_key,variant,real_cost_yuan,cost_source,enabled,updated_at) VALUES ('wan2.7-t2v:720P','wan2.7-t2v','720P',0.6,'doc',1,0)`).run();
    setConfig('markup_x35', '40');
    expect(videoPriceTier(getVideoModel('wan2.7-t2v'), '720P', false)).toBe(24); // ⌈0.6×40⌉
  });
  it('无 override 行 → 回落代码常数(迁移前兜底)', () => {
    // 不插行;回落 def.priceTier(代码里 wan2.7-t2v 720P=21)
    expect(videoPriceTier(getVideoModel('wan2.7-t2v'), '720P', false)).toBe(21);
  });
});
