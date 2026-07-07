// 灵镜 — GPT Image 2 真实 token 计价结算(Design B)。
// 覆盖:① reserve 上界估算(无 usageSnapshot)② settle 按实(有 usageSnapshot)
//   ③ settle ≤ reserved(永不超扣)④ priceRateSnapshot 优先(reserve==settle 护栏)
//   ⑤ 报价≡预扣(build 与 estimate 同经 costFor)⑥ 种子 enabled=0(admin 录 key 前不上线)。

import { describe, it, expect } from 'vitest';

process.env.DB_FILE = ':memory:';
process.env.MASTER_KEY = 'test-master-key-for-gptimg2-vitest3';
const { db } = await import('../src/db/index.js');
const { costFor, estImageOutputTokens, imageTokenRate } = await import('../src/credits/index.js');
const { sellPrice } = await import('../src/credits/pricing.js');
const { IMAGE_MODELS } = await import('../src/gateway/image-models.js');
const { seedPlatformDefaults } = await import('../src/seed/platform-defaults.js');

const RATE = IMAGE_MODELS['gpt-image-2']!.priceRate!; // 0.000216 ¥/output token(代码回落)

describe('reserve 上界估算(无 usageSnapshot)', () => {
  it('按(画质,像素)出上界 = sellPrice(estOutputTokens × rate);画质越高越贵', () => {
    const base = { model: 'gpt-image-2', mode: 'text2img', ratio: '1:1', resolution: '1K' };
    const low = costFor('ai_image', { ...base, quality: 'low' });
    const medium = costFor('ai_image', { ...base, quality: 'medium' });
    const high = costFor('ai_image', { ...base, quality: 'high' });
    expect(low).toBe(sellPrice(estImageOutputTokens('low', 1024, 1024) * RATE));
    expect(medium).toBe(sellPrice(estImageOutputTokens('medium', 1024, 1024) * RATE));
    expect(high).toBe(sellPrice(estImageOutputTokens('high', 1024, 1024) * RATE));
    expect(low).toBeLessThan(medium);
    expect(medium).toBeLessThan(high);
  });

  it('分辨率越大 reserve 越高(像素驱动)', () => {
    const base = { model: 'gpt-image-2', mode: 'text2img', ratio: '1:1', quality: 'high' };
    const r1k = costFor('ai_image', { ...base, resolution: '1K' });
    const r4k = costFor('ai_image', { ...base, resolution: '4K' });
    expect(r4k).toBeGreaterThan(r1k);
  });
});

describe('settle 按实 usage + 永不超扣', () => {
  it('有 usageSnapshot → settle = sellPrice(outputTokens × rate)', () => {
    const cost = costFor('ai_image', {
      model: 'gpt-image-2', mode: 'text2img', quality: 'high', resolution: '1K', ratio: '1:1',
      usageSnapshot: { inputTokens: 20, outputTokens: 7033, totalTokens: 7053 },
    });
    expect(cost).toBe(sellPrice(7033 * RATE)); // 官方 high 1024² ≈ 7033 token → 与手算 54 积分一致
    expect(cost).toBe(54);
  });

  it('真实 usage ≤ reserve 估算 → settle 只退不补(reserve ≥ settle)', () => {
    const base = { model: 'gpt-image-2', mode: 'text2img', quality: 'high', resolution: '1K', ratio: '1:1' };
    const reserve = costFor('ai_image', base); // 无 usage:上界估算
    const settle = costFor('ai_image', { ...base, usageSnapshot: { inputTokens: 20, outputTokens: 7033, totalTokens: 7053 } });
    expect(reserve).toBeGreaterThanOrEqual(settle); // 估算上界 ≥ 实际 → worker Math.min 封顶 reserved 只退不补
  });
});

describe('priceRateSnapshot 优先(reserve==settle 护栏)', () => {
  it('快照 rate 生效,不受当前 model_pricing/代码常量影响', () => {
    const snapRate = RATE * 2; // 提交时快照的高 rate
    const cost = costFor('ai_image', {
      model: 'gpt-image-2', mode: 'text2img', quality: 'high', resolution: '1K', ratio: '1:1',
      priceRateSnapshot: snapRate,
      usageSnapshot: { inputTokens: 0, outputTokens: 7033, totalTokens: 7033 },
    });
    expect(cost).toBe(sellPrice(7033 * snapRate));
    expect(imageTokenRate(IMAGE_MODELS['gpt-image-2']!, snapRate)).toBe(snapRate);
  });
});

describe('费率单位护栏(防 ¥/张 误读成 ¥/token,QA 实测 17260 灌爆)', () => {
  const ins = (unit: string, cost: number) => db.prepare(
    `INSERT OR REPLACE INTO model_pricing (id,model_key,modality,unit,variant,real_cost_yuan,cost_source,enabled,sort_order,updated_at)
     VALUES ('gpt-image-2','gpt-image-2','image',?,NULL,?,'doc',1,0,1)`,
  ).run(unit, cost);

  it('unit=张 的行(admin 经每张定价表误填 0.029)被忽略 → 回落代码常量,不 134× 灌爆', () => {
    ins('张', 0.029); // 误填 ¥/张
    const def = IMAGE_MODELS['gpt-image-2']!;
    expect(imageTokenRate(def)).toBe(def.priceRate); // 0.000216,非 0.029
    // 9:16 4K medium:用 0.029 会算出 17260;护栏后回落 0.000216 → 合理档
    const cost = costFor('ai_image', { model: 'gpt-image-2', mode: 'text2img', ratio: '9:16', resolution: '4K', quality: 'medium' });
    expect(cost).toBeLessThan(300); // 远小于 17260(实为 ~129)
  });

  it('unit=token 的行生效(admin 经 token 费率正常调价)', () => {
    ins('token', 0.0003);
    expect(imageTokenRate(IMAGE_MODELS['gpt-image-2']!)).toBe(0.0003);
  });
});

describe('种子 + 启用', () => {
  it('seedPlatformDefaults 种 gpt-image-2 → enabled=0(admin 录 key 前不上线)', () => {
    db.prepare('DELETE FROM model_pricing WHERE id=?').run('gpt-image-2'); // 清前序 describe 的污染(共享 :memory:)
    seedPlatformDefaults();
    const row = db.prepare('SELECT enabled, unit, cost_source, real_cost_yuan FROM model_pricing WHERE id=?').get('gpt-image-2') as any;
    expect(row).toBeTruthy();
    expect(row.enabled).toBe(0); // 默认停用
    expect(row.unit).toBe('token'); // token 计价
    expect(row.cost_source).toBe('doc'); // $30/1M 是官方文档价
    expect(row.real_cost_yuan).toBeCloseTo(0.000216, 9); // 每 output token 成本元
  });
});
