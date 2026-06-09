// 灵镜 AI图片模型 DB 覆盖层测试(CEO A2:代码拥有技术契约,DB 只覆盖展示/运营字段)。
//
// 覆盖:getImageModel DB 合并、默认禁用兜底(P1-default)、listEnabledModels、seed 透传校验、
// costFor 快照(P3)。强制隔离:每测清表,保「无 override 时 getImageModel == 纯代码」。

import { describe, it, expect, beforeEach } from 'vitest';

process.env.DB_FILE = ':memory:';

const { db } = await import('../src/db/index.js');
const { getImageModel, listEnabledModels, isKnownModel, IMAGE_MODELS, DEFAULT_IMAGE_MODEL } = await import(
  '../src/gateway/image-models.js'
);
const { costFor } = await import('../src/credits/index.js');

function clearOv() { db.prepare('DELETE FROM image_model_override').run(); }
function addOv(row: Record<string, unknown>) {
  db.prepare(
    `INSERT OR REPLACE INTO image_model_override (key,label,model_id,enabled,price_tier,max_images,shape_template,created_at)
     VALUES (@key,@label,@model_id,@enabled,@price_tier,@max_images,@shape_template,@created_at)`,
  ).run({ enabled: 1, shape_template: null, created_at: 0, ...row });
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
});

describe('默认兜底(P1-default:禁用默认 → 跳 enabled)', () => {
  beforeEach(clearOv);

  it('默认模型被禁用 → getImageModel(undefined) 返回首个 enabled,非 disabled 默认', () => {
    addOv({ key: DEFAULT_IMAGE_MODEL, label: 'x', model_id: 'x', price_tier: 4, max_images: 4, enabled: 0, shape_template: DEFAULT_IMAGE_MODEL });
    const d = getImageModel(undefined, 'text2img');
    expect(d.modes).toContain('text2img');
    // 不应是被禁用的默认(它 enabled=0);应是另一个 enabled text2img 模型
    const ov = db.prepare('SELECT enabled FROM image_model_override WHERE key=?').get(d.key) as { enabled: number } | undefined;
    expect(ov?.enabled ?? 1).toBe(1);
  });

  it('显式取 disabled 模型仍允许(在飞/老 job 兼容)', () => {
    addOv({ key: 'z-image', label: 'x', model_id: 'x', price_tier: 2, max_images: 1, enabled: 0, shape_template: 'z-image' });
    expect(getImageModel('z-image').key).toBe('z-image'); // 显式取到
  });
});

describe('listEnabledModels / isKnownModel', () => {
  beforeEach(clearOv);
  it('listEnabledModels 只列 enabled', () => {
    addOv({ key: 'z-image', label: 'x', model_id: 'x', price_tier: 2, max_images: 1, enabled: 0, shape_template: 'z-image' });
    const keys = listEnabledModels().map((d) => d.key);
    expect(keys).not.toContain('z-image'); // 被禁
    expect(keys).toContain('qwen-image'); // 仍启用
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
