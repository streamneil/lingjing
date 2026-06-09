// 灵镜 AI 图片(文生图)后端测试 —— 计价 / n clamp / 工具分发 / 多图输出兼容。
//
// 覆盖 /plan-eng-review 测试覆盖图的图片相关 GAP:
//   - costFor('ai_image') 计价 + n clamp [1,4]
//   - costFor('video') 不变(回归)
//   - 未知 type 计价抛错(防御)
//   - signOutputUrls 多图 / 单视频向后兼容(裸字符串)
//   - enqueueJob 写对 type;markDone 写对 output_kind

import { describe, it, expect, beforeEach } from 'vitest';

process.env.DB_FILE = ':memory:';

const { db } = await import('../src/db/index.js');
const { costFor, estimateImageCost, clampImageCount, estimateCost } = await import(
  '../src/credits/index.js'
);
const { enqueueJob, markDone, getJob } = await import('../src/queue/index.js');

describe('AI 图片计价(costFor / estimateImageCost / clampImageCount)', () => {
  it('clampImageCount:夹到 [1,4],非法值兜底 1', () => {
    expect(clampImageCount(1)).toBe(1);
    expect(clampImageCount(4)).toBe(4);
    expect(clampImageCount(0)).toBe(1);
    expect(clampImageCount(5)).toBe(4);
    expect(clampImageCount(-3)).toBe(1);
    expect(clampImageCount(2.9)).toBe(2); // floor
    expect(clampImageCount(undefined)).toBe(1);
    expect(clampImageCount('x' as unknown)).toBe(1);
    expect(clampImageCount(NaN)).toBe(1);
  });

  it('estimateImageCost:图数 × 分辨率系数,n 先 clamp', () => {
    expect(estimateImageCost(1, '1K')).toBe(4); // 1*4*1
    expect(estimateImageCost(2, '1K')).toBe(8); // 2*4*1
    expect(estimateImageCost(4, '2K')).toBe(24); // 4*4*1.5
    expect(estimateImageCost(5, '1K')).toBe(16); // clamp 5→4 → 4*4*1
    expect(estimateImageCost(1, '4K')).toBe(10); // 1*4*2.5
  });

  it("costFor('ai_image') = estimateImageCost(count,resolution)", () => {
    expect(costFor('ai_image', { count: 2, resolution: '1K' })).toBe(estimateImageCost(2, '1K'));
    expect(costFor('ai_image', { count: 5, resolution: '2K' })).toBe(estimateImageCost(5, '2K')); // clamp
    expect(costFor('ai_image', {})).toBe(estimateImageCost(1, '1K')); // 默认 1 张 1K
  });

  it("costFor('video') 与 estimateCost 一致(回归,视频计价不变)", () => {
    expect(costFor('video', { script: 'a'.repeat(100), resolution: '720P' })).toBe(
      estimateCost(100, '720P'),
    );
    expect(costFor('video', {})).toBe(estimateCost(0)); // 空脚本→MIN_COST
  });

  it('未知 type 计价抛错(防御)', () => {
    expect(() => costFor('__proto__', {})).toThrow();
    expect(() => costFor('nope', {})).toThrow();
  });

  it("costFor('ai_image', mode=img2img) 走编辑价(固定 1 张,外部声音 P1 mode 感知)", async () => {
    const { estimateImageEditCost } = await import('../src/credits/index.js');
    expect(costFor('ai_image', { mode: 'img2img', resolution: '1K' })).toBe(estimateImageEditCost('1K'));
    expect(costFor('ai_image', { mode: 'img2img', resolution: '2K' })).toBe(estimateImageEditCost('2K'));
    // img2img 忽略 count(固定 1 张)→ 不受客户端传 count 影响,reserve==settle 不破
    expect(costFor('ai_image', { mode: 'img2img', count: 4, resolution: '1K' })).toBe(
      estimateImageEditCost('1K'),
    );
  });
});


describe('队列:enqueueJob type + markDone output_kind', () => {
  const T = 'tenant-img-test';
  beforeEach(() => {
    db.prepare('DELETE FROM job').run();
  });

  it('enqueueJob 写对 type;markDone 写对 output_kind 与 JSON output_url', () => {
    const id = enqueueJob('ai_image', { prompt: '一只猫', count: 2 }, T);
    let row = getJob(id)!;
    expect(row.type).toBe('ai_image');
    expect(row.output_kind).toBe('video'); // 默认值(未完成)

    markDone(id, JSON.stringify(['images/t/a.png', 'images/t/b.png']), 'none', 'image');
    row = getJob(id)!;
    expect(row.status).toBe('done');
    expect(row.output_kind).toBe('image');
    expect(JSON.parse(row.output_url!)).toEqual(['images/t/a.png', 'images/t/b.png']);
  });

  it('enqueueVideo 仍写 type=video(回归)', async () => {
    const { enqueueVideo } = await import('../src/queue/index.js');
    const id = enqueueVideo({ avatarRef: 'a', voiceRef: 'v', script: 's' } as never, T);
    expect(getJob(id)!.type).toBe('video');
  });
});

describe('imageSize(比例 + 分辨率 → W*H)', () => {
  it('1:1 各分辨率边长正确', async () => {
    const { imageSize } = await import('../src/gateway/baichuan.js');
    expect(imageSize('1:1', '1K')).toBe('1024*1024');
    expect(imageSize('1:1', '2K')).toBe('1440*1440');
    expect(imageSize('1:1', '4K')).toBe('2048*2048');
  });
  it('横/竖比例:长边贴基数,短边按比例 + 8 像素对齐', async () => {
    const { imageSize } = await import('../src/gateway/baichuan.js');
    expect(imageSize('16:9', '1K')).toBe('1024*576'); // 长1024,短=1024*9/16=576
    expect(imageSize('9:16', '1K')).toBe('576*1024'); // 竖,宽短
  });
  it('auto / 未知比例 → 1:1 兜底', async () => {
    const { imageSize } = await import('../src/gateway/baichuan.js');
    expect(imageSize('auto', '1K')).toBe('1024*1024');
    expect(imageSize(undefined, undefined)).toBe('1024*1024');
  });
});

// ── 多模型 registry(/plan-eng-review E1/E3 + 外部声音核实)──
const { IMAGE_MODELS, getImageModel, sizeParams, resolutionAllowed, DEFAULT_IMAGE_MODEL } = await import(
  '../src/gateway/image-models.js'
);

describe('图像模型 registry 自洽性(E1 命脉)', () => {
  it('每个 model 配置自洽,无矛盾', () => {
    for (const [key, def] of Object.entries(IMAGE_MODELS)) {
      expect(def.key).toBe(key); // key 与 map 键一致
      expect(['S', 'A1', 'A2']).toContain(def.shape);
      expect(['wh', 'keyword', 'aspect_res']).toContain(def.sizeKind);
      expect(def.modes.length).toBeGreaterThan(0);
      expect(def.maxImages).toBeGreaterThanOrEqual(1);
      expect(['1K', '2K', '4K']).toContain(def.maxResolution);
      expect(def.priceTier).toBeGreaterThan(0);
      // img2img 模型必须能收输入图;纯 text2img 模型 maxInputImages=0
      if (def.modes.includes('img2img')) expect(def.maxInputImages).toBeGreaterThanOrEqual(1);
      else expect(def.maxInputImages).toBe(0);
      // v1:A2(可灵)缓,不应有 A2 模型上线
      expect(def.shape).not.toBe('A2');
      // 输入图上限 v1 封顶 3(上传端点写死,P2-c)
      expect(def.maxInputImages).toBeLessThanOrEqual(3);
    }
  });
});

describe('getImageModel 默认兜底(C5b 老 job 兼容)', () => {
  it('已知 key 取到;未知/缺省 → 默认', () => {
    expect(getImageModel('z-image').modelId).toBe('z-image-turbo');
    expect(getImageModel(undefined).key).toBe(DEFAULT_IMAGE_MODEL);
    expect(getImageModel('不存在的model').key).toBe(DEFAULT_IMAGE_MODEL);
  });
});

describe('sizeParams 按 sizeKind(E3 / 外部声音 P1-size)', () => {
  it('wh → {size:"W*H"}', () => {
    const p = sizeParams(getImageModel('qwen-image'), '1:1', '1K');
    expect(p.size).toMatch(/^\d+\*\d+$/); // W*H
  });
  it('keyword → {size:"2K"}(假想 keyword 模型)', () => {
    const fake = { ...getImageModel('qwen-image'), sizeKind: 'keyword' as const };
    expect(sizeParams(fake, '1:1', '2k').size).toBe('2K');
  });
});

describe('resolutionAllowed(4K 不支持 → false,P2-4k)', () => {
  it('非 4K 模型拒 4K;4K 模型放行', () => {
    expect(resolutionAllowed(getImageModel('z-image'), '4K')).toBe(false); // maxRes 2K
    expect(resolutionAllowed(getImageModel('qwen-image-2.0-pro'), '4K')).toBe(true);
    expect(resolutionAllowed(getImageModel('z-image'), '2K')).toBe(true);
  });
});

describe('costFor model-aware(priceTier 替代基价 + maxImages clamp,外部声音 P1/P2)', () => {
  it('clampImageCount(4, z-image maxImages=1) → 1(防超扣)', () => {
    expect(clampImageCount(4, getImageModel('z-image').maxImages)).toBe(1);
  });
  it('不同 model priceTier 计价不同', () => {
    const cheap = costFor('ai_image', { model: 'z-image', mode: 'text2img', count: 1, resolution: '1K' });
    const pro = costFor('ai_image', { model: 'qwen-image-2.0-pro', mode: 'text2img', count: 1, resolution: '1K' });
    expect(pro).toBeGreaterThan(cheap); // priceTier 8 vs 2
  });
  it('无 model 字段 → 默认计价(老 job 兼容,不抛错)', () => {
    expect(() => costFor('ai_image', { mode: 'text2img', count: 1 })).not.toThrow();
  });
});

// 注:所有 spy globalThis.fetch 的 adapter 测试移到 test/baichuan-adapter.test.ts(独立文件,
// 避免进程级 fetch spy 在 vitest 并行跑时泄漏到其它文件,见该文件头注释)。
