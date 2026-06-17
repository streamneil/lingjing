// 灵镜 AI图片模型 DB 覆盖层测试(CEO A2:代码拥有技术契约,DB 只覆盖展示/运营字段)。
//
// 覆盖:getImageModel DB 合并、默认禁用兜底(P1-default)、listEnabledModels、seed 透传校验、
// costFor 快照(P3)。强制隔离:每测清表,保「无 override 时 getImageModel == 纯代码」。

import { describe, it, expect, beforeEach } from 'vitest';

process.env.DB_FILE = ':memory:';

const { db } = await import('../src/db/index.js');
const { getImageModel, listEnabledModels, isKnownModel, sizeParams, tierFromPixels, IMAGE_MODELS, DEFAULT_IMAGE_MODEL } = await import(
  '../src/gateway/image-models.js'
);
const { costFor } = await import('../src/credits/index.js');

function clearOv() { db.prepare('DELETE FROM image_model_override').run(); }
function addOv(row: Record<string, unknown>) {
  db.prepare(
    `INSERT OR REPLACE INTO image_model_override (key,label,model_id,enabled,price_tier,max_images,shape_template,modes,sort_order,resolutions,created_at)
     VALUES (@key,@label,@model_id,@enabled,@price_tier,@max_images,@shape_template,@modes,@sort_order,@resolutions,@created_at)`,
  ).run({ enabled: 1, shape_template: null, modes: null, sort_order: 0, resolutions: null, created_at: 0, ...row });
}

describe('getImageModel DB 合并', () => {
  beforeEach(clearOv);

  it('无 override → 纯代码常量(回归:现有调用不变)', () => {
    const d = getImageModel('z-image');
    expect(d).toEqual(IMAGE_MODELS['z-image']);
  });

  it('override 覆盖 label/modelId/price/maxImages,技术字段仍代码', () => {
    addOv({ key: 'z-image', label: '极速版改名', model_id: 'z-image-v2', price_tier: 99, max_images: 1, shape_template: 'z-image' });
    const d = getImageModel('z-image');
    expect(d.label).toBe('极速版改名');
    expect(d.modelId).toBe('z-image-v2');
    expect(d.priceTier).toBe(99);
    // 技术契约不变(来自代码)
    expect(d.shape).toBe(IMAGE_MODELS['z-image']!.shape);
    expect(d.sizeKind).toBe(IMAGE_MODELS['z-image']!.sizeKind);
    expect(d.maxResolution).toBe(IMAGE_MODELS['z-image']!.maxResolution);
  });

  it('DB 新增模型(shape_template 指向代码模板)→ 技术字段从模板取', () => {
    addOv({ key: 'my-model', label: '自定义', model_id: 'wan2.2-t2i-flash', price_tier: 5, max_images: 4, shape_template: 'qwen-image' });
    const d = getImageModel('my-model');
    expect(d.label).toBe('自定义');
    expect(d.shape).toBe(IMAGE_MODELS['qwen-image']!.shape); // A1
    expect(d.sizeKind).toBe(IMAGE_MODELS['qwen-image']!.sizeKind);
  });

  it('DB 模型 shape_template=qwen-image-2.0-pro → 继承 pixelMatrix(真实 qwen-image-2.0 配法)', () => {
    // 线上 qwen-image-2.0 即此形态:override 行 shape_template 指向 pro 模板。
    // pixelMatrix 是代码模板字段(override 无此列),经 mergeDef ...tmpl 自动继承 → 发官方对齐尺寸。
    addOv({ key: 'qwen-image-2.0', label: '千问2.0', model_id: 'qwen-image-2.0', price_tier: 7, max_images: 6, shape_template: 'qwen-image-2.0-pro', modes: 'text2img,img2img' });
    const d = getImageModel('qwen-image-2.0', 'img2img');
    expect(d.pixelMatrix).toBeTruthy();
    expect(sizeParams(d, '3:4', '1K').size).toBe('960*1280');
    expect(sizeParams(d, '16:9', '2K').size).toBe('1920*1080');
  });
});

describe('默认兜底(P1-default:禁用默认 → 跳 enabled)', () => {
  beforeEach(clearOv);

  it('默认模型被禁用 → getImageModel(undefined) 返回首个 enabled,非 disabled 默认', () => {
    addOv({ key: DEFAULT_IMAGE_MODEL, label: 'x', model_id: 'x', price_tier: 4, max_images: 4, enabled: 0, shape_template: DEFAULT_IMAGE_MODEL });
    // 新规则(2026-06):enabled 唯一真源=DB 行。需显式给一个备选 enabled text2img 模型,否则全不启用。
    addOv({ key: 'wan2.2-flash', label: 'y', model_id: 'wan2.2-t2i-flash', price_tier: 5, max_images: 4, enabled: 1, shape_template: 'wan2.2-flash' });
    const d = getImageModel(undefined, 'text2img');
    expect(d.modes).toContain('text2img');
    // 不应是被禁用的默认(它 enabled=0);应是另一个 enabled text2img 模型
    const ov = db.prepare('SELECT enabled FROM image_model_override WHERE key=?').get(d.key) as { enabled: number } | undefined;
    expect(ov?.enabled ?? 0).toBe(1); // 注:默认改为0(无行=不启用)
  });

  it('显式取 disabled 模型仍允许(在飞/老 job 兼容)', () => {
    addOv({ key: 'z-image', label: 'x', model_id: 'x', price_tier: 2, max_images: 1, enabled: 0, shape_template: 'z-image' });
    expect(getImageModel('z-image').key).toBe('z-image'); // 显式取到
  });
});

describe('modes 管理员可选(DB modes 覆盖代码模板)', () => {
  beforeEach(clearOv);

  it('DB modes 设了 → 用 DB 的(管理员勾选优先)', () => {
    // qwen-image 代码模板 modes=[text2img];管理员勾上 img2img(自由勾)
    addOv({ key: 'qwen-image', label: 'x', model_id: 'qwen-image', price_tier: 4, max_images: 4, shape_template: 'qwen-image', modes: 'text2img,img2img' });
    expect(getImageModel('qwen-image').modes).toEqual(['text2img', 'img2img']);
  });

  it('DB modes 为空 → 回落代码模板 modes', () => {
    addOv({ key: 'qwen-image', label: 'x', model_id: 'qwen-image', price_tier: 4, max_images: 4, shape_template: 'qwen-image', modes: null });
    expect(getImageModel('qwen-image').modes).toEqual(IMAGE_MODELS['qwen-image']!.modes);
  });
});

describe('sort_order 排序(listEnabledModels)', () => {
  beforeEach(clearOv);
  it('按 sort_order 升序;有 override 的优先于代码默认序', () => {
    addOv({ key: 'z-image', label: 'z', model_id: 'z', price_tier: 2, max_images: 1, shape_template: 'z-image', sort_order: 0 });
    addOv({ key: 'qwen-image', label: 'q', model_id: 'q', price_tier: 4, max_images: 4, shape_template: 'qwen-image', sort_order: 1 });
    const keys = listEnabledModels().map((d) => d.key);
    expect(keys.indexOf('z-image')).toBeLessThan(keys.indexOf('qwen-image')); // z(0) 在 qwen(1) 前
  });
});

describe('listEnabledModels / isKnownModel', () => {
  beforeEach(clearOv);
  it('listEnabledModels 只列 enabled(无 DB 行=不启用,2026-06 新规则)', () => {
    addOv({ key: 'z-image', label: 'x', model_id: 'x', price_tier: 2, max_images: 1, enabled: 0, shape_template: 'z-image' });
    addOv({ key: 'qwen-image', label: 'x', model_id: 'qwen-image', price_tier: 9, max_images: 1, enabled: 1, shape_template: 'qwen-image' });
    const keys = listEnabledModels().map((d) => d.key);
    expect(keys).not.toContain('z-image'); // 被禁
    expect(keys).toContain('qwen-image'); // 有 enabled 行 → 启用
    // 无 DB 行的代码模板模型不再默认启用(治"默认即启用"地雷)
    expect(keys).not.toContain('wan2.7-image-pro');
  });
  it('isKnownModel:代码 key + DB 新增 key', () => {
    expect(isKnownModel('z-image')).toBe(true);
    expect(isKnownModel('不存在')).toBe(false);
    addOv({ key: 'dbnew', label: 'x', model_id: 'x', price_tier: 1, max_images: 1, shape_template: 'qwen-image' });
    expect(isKnownModel('dbnew')).toBe(true);
  });
});

describe('costFor 快照优先(P3)', () => {
  beforeEach(clearOv);
  it('input 带 priceTierSnapshot → 用快照(admin 改价 mid-flight 不破 reserve==settle)', () => {
    // 模型实时价 4,但 input 快照 10 → 用 10
    const c = costFor('ai_image', { model: 'qwen-image', mode: 'text2img', count: 1, resolution: '1K', priceTierSnapshot: 10, maxImagesSnapshot: 4 });
    expect(c).toBe(10); // 1 张 × 10 × 1K(factor 1)
  });
  it('无快照(老 job)→ 回落实时价', () => {
    const c = costFor('ai_image', { model: 'z-image', mode: 'text2img', count: 1, resolution: '1K' });
    expect(c).toBe(IMAGE_MODELS['z-image']!.priceTier); // 2
  });
});

// ── 分辨率列表(admin 录百炼官方表;tier 由像素自动推,钱不塌)──
describe('tierFromPixels(像素 → 计价档)', () => {
  it('1.3MP / 3MP 阈值边界正确', () => {
    expect(tierFromPixels(1024, 1024)).toBe('1K'); // 1.05MP ≤1.3
    expect(tierFromPixels(1140, 1140)).toBe('1K'); // 1.2996MP 恰好 ≤1.3
    expect(tierFromPixels(1280, 1280)).toBe('2K'); // 1.638MP >1.3 → 2K
    expect(tierFromPixels(1700, 1700)).toBe('2K'); // 2.89MP ≤3
    expect(tierFromPixels(1730, 1730)).toBe('2K'); // 2.9929MP 恰好 ≤3
    expect(tierFromPixels(1740, 1740)).toBe('4K'); // 3.0276MP >3 → 4K
  });
  it('百炼官方典型尺寸落到正确档(护钱:qwen-2.0 大图必须 2K/4K 不塌成 1K)', () => {
    expect(tierFromPixels(2048, 2048)).toBe('4K'); // 4.19MP >3 → 4K
    expect(tierFromPixels(2688, 1536)).toBe('4K'); // qwen-2.0 16:9 4.13MP >3
    expect(tierFromPixels(1328, 1328)).toBe('2K'); // qwen-max 1:1 1.76MP
    expect(tierFromPixels(1664, 928)).toBe('2K'); // qwen-max 16:9 1.54MP
    expect(tierFromPixels(928, 1664)).toBe('2K'); // 同上竖
  });
});

describe('mergeDef 注入 resolutions + 坏 JSON 兜底(P2-c 热路径不崩)', () => {
  beforeEach(clearOv);
  it('合法 JSON → def.resolutions 注入', () => {
    addOv({
      key: 'qwen-image', label: 'x', model_id: 'qwen-image', price_tier: 4, max_images: 4, shape_template: 'qwen-image',
      resolutions: JSON.stringify([{ ratio: '1:1', width: 2048, height: 2048, isDefault: true }, { ratio: '16:9', width: 2688, height: 1536 }]),
    });
    const d = getImageModel('qwen-image');
    expect(d.resolutions).toHaveLength(2);
    expect(d.resolutions!.find((r) => r.ratio === '1:1')!.width).toBe(2048);
  });
  it('坏 JSON → 回落代码默认(undefined),不抛', () => {
    addOv({ key: 'qwen-image', label: 'x', model_id: 'qwen-image', price_tier: 4, max_images: 4, shape_template: 'qwen-image', resolutions: '{不是合法json' });
    expect(() => getImageModel('qwen-image')).not.toThrow();
    expect(getImageModel('qwen-image').resolutions).toBeUndefined();
  });
  it('空数组 / 非数组 → undefined(不留半截脏数据)', () => {
    addOv({ key: 'qwen-image', label: 'x', model_id: 'qwen-image', price_tier: 4, max_images: 4, shape_template: 'qwen-image', resolutions: '[]' });
    expect(getImageModel('qwen-image').resolutions).toBeUndefined();
  });
  it('过滤非法行(width/height 非正)→ 只留合法', () => {
    addOv({
      key: 'qwen-image', label: 'x', model_id: 'qwen-image', price_tier: 4, max_images: 4, shape_template: 'qwen-image',
      resolutions: JSON.stringify([{ ratio: '1:1', width: 2048, height: 2048 }, { ratio: '16:9', width: 0, height: 1536 }]),
    });
    const d = getImageModel('qwen-image');
    expect(d.resolutions).toHaveLength(1);
    expect(d.resolutions?.[0]?.ratio).toBe('1:1');
  });
});

describe('sizeParams 读 resolutions 表(快照优先 → 查表 → imageSize 回落)', () => {
  beforeEach(clearOv);
  function withRes() {
    addOv({
      key: 'qwen-image', label: 'x', model_id: 'qwen-image', price_tier: 4, max_images: 4, shape_template: 'qwen-image',
      resolutions: JSON.stringify([{ ratio: '1:1', width: 2048, height: 2048, isDefault: true }, { ratio: '16:9', width: 2688, height: 1536 }]),
    });
    return getImageModel('qwen-image');
  }
  it('比例命中 → 用表里官方 W×H(不猜)', () => {
    expect(sizeParams(withRes(), '16:9').size).toBe('2688*1536');
    expect(sizeParams(withRes(), '1:1').size).toBe('2048*2048');
  });
  it('比例缺/未命中 → 默认行(isDefault),否则首行', () => {
    expect(sizeParams(withRes(), undefined).size).toBe('2048*2048'); // ratio 缺 → '1:1' 命中默认
    expect(sizeParams(withRes(), '21:9').size).toBe('2048*2048'); // 未命中 → isDefault 行
  });
  it('快照优先于表(在飞 job:admin 改表不影响)', () => {
    expect(sizeParams(withRes(), '16:9', undefined, { width: 999, height: 888 }).size).toBe('999*888');
  });
  it('无 resolutions 表 → imageSize 回落(老 job/未配模型)', () => {
    const d = getImageModel('z-image'); // 无 override
    expect(d.resolutions).toBeUndefined();
    expect(sizeParams(d, '1:1', '1K').size).toMatch(/^\d+\*\d+$/);
  });
});

// z-image 官方推荐尺寸矩阵(pixelMatrix)——修偏小公式(16:9 1024×576 → 文档 1280×720)。
describe('z-image pixelMatrix 官方推荐尺寸', () => {
  beforeEach(() => clearOv()); // 纯代码 def(无 override),走 pixelMatrix
  it('1K 档按文档:16:9=1280*720(非公式的 1024*576)、1:1=1024*1024', () => {
    const d = getImageModel('z-image');
    expect(d.pixelMatrix).toBeDefined();
    expect(sizeParams(d, '16:9', '1K').size).toBe('1280*720');
    expect(sizeParams(d, '1:1', '1K').size).toBe('1024*1024');
    expect(sizeParams(d, '9:16', '1K').size).toBe('720*1280');
    expect(sizeParams(d, '3:4', '1K').size).toBe('864*1152');
  });
  it('2K 档映到文档 1536 tier:16:9=2048*1152、1:1=1536*1536', () => {
    const d = getImageModel('z-image');
    expect(sizeParams(d, '16:9', '2K').size).toBe('2048*1152');
    expect(sizeParams(d, '1:1', '2K').size).toBe('1536*1536');
  });
  it('未知比例/缺省档回落 1:1 / 首档,不抛错', () => {
    const d = getImageModel('z-image');
    expect(sizeParams(d, undefined, undefined).size).toBe('1024*1024'); // 首档 1K + 1:1
    expect(sizeParams(d, '21:9', '1K').size).toBe('1024*1024'); // UI 无此比例 → 回落 1:1
  });
  it('所有 z-image 推荐尺寸都在 [512*512, 2048*2048] 合法范围', () => {
    const d = getImageModel('z-image');
    for (const tier of Object.values(d.pixelMatrix!)) {
      for (const wh of Object.values(tier)) {
        const parts = wh.split('*').map(Number);
        const px = parts[0]! * parts[1]!;
        expect(px).toBeGreaterThanOrEqual(512 * 512);
        expect(px).toBeLessThanOrEqual(2048 * 2048);
      }
    }
  });
});
