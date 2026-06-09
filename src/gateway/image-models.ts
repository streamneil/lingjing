// 灵镜 图像模型注册表 —— 单一真相源(前端下拉 + worker dispatch + 计价 + 校验全读它)。
//
// 决策来源:/plan-ceo-review(SELECTIVE_EXPANSION)+ /plan-eng-review。
// 核心洞察:百炼十几个图像模型,调用形状只有 ~3 种。本轮做 S + A1(代码现成),A2(可灵)缓。
//
// ⚠️ 外部声音两轮核实的两个非显然维度:
//  - sizeKind(P1-size):size 参数形状在 shape 内不同。qwen-2.0=W*H(wh)、wan2.7="2K"(keyword)、
//    可灵=aspect_ratio+resolution(aspect_res,本轮缓)。一个 imageSize 发 W*H 给 wan2.7 会静默 400。
//  - shape × mode(P1-b):一个 S 模型 text2img(纯文本体)与 img2img(含图体)请求体不同。
//    worker 必须按 (shape, mode) 子分发,不能只按 shape。
//
//        模型选择数据流
//   前端 fetch GET /image-models ──► 下拉(label/badge/modes)
//          │ 用户选 modelKey
//          ▼
//   buildImageJob: getModel(key ?? 默认) ─► 校验 mode/张数/分辨率 ─► clamp(n,maxImages)
//          │
//          ▼
//   worker: (registry[key].shape, mode)
//     ├ S + text2img → generateImageSync(纯文本 content)
//     ├ S + img2img  → editImage(含图 content)
//     └ A1 + text2img → submitImage → 轮询

import { imageSize } from './baichuan.js';

export type ImageShape = 'S' | 'A1' | 'A2'; // S=同步多模态 A1=异步文生图 A2=异步图生成(缓)
export type SizeKind = 'wh' | 'keyword' | 'aspect_res'; // size 参数形状(aspect_res 本轮缓)
export type ImageMode = 'text2img' | 'img2img';

export interface ImageModelDef {
  key: string; // 内部 key(input.model 存它)
  label: string; // UI 标签
  modelId: string; // 百炼实际 model 名
  shape: ImageShape;
  sizeKind: SizeKind;
  modes: ImageMode[]; // 支持的模式
  maxImages: number; // 出图张数上限(z-image 固定1、qwen-2.0 6)
  maxInputImages: number; // img2img 输入图上限(text2img 模型 0);v1 封顶 3(上传端点写死,P2-c)
  maxResolution: '1K' | '2K' | '4K'; // 最高分辨率档
  priceTier: number; // 每张计价(替代 PRICE_PER_IMAGE,非双乘 P2-a)
}

// 精选 5 模型(全 S/A1,代码现成)。modelId 按用户给的百炼文档核实。
export const IMAGE_MODELS: Record<string, ImageModelDef> = {
  'z-image': {
    key: 'z-image', label: '极速', modelId: 'z-image-turbo',
    shape: 'S', sizeKind: 'wh', modes: ['text2img'],
    maxImages: 1, maxInputImages: 0, maxResolution: '2K', priceTier: 2,
  },
  'qwen-image': {
    key: 'qwen-image', label: '标准', modelId: 'qwen-image',
    shape: 'A1', sizeKind: 'wh', modes: ['text2img'],
    maxImages: 4, maxInputImages: 0, maxResolution: '2K', priceTier: 4,
  },
  'qwen-image-2.0-pro': {
    key: 'qwen-image-2.0-pro', label: '专业 (千问2.0 Pro)', modelId: 'qwen-image-2.0-pro',
    shape: 'S', sizeKind: 'wh', modes: ['text2img', 'img2img'],
    maxImages: 6, maxInputImages: 3, maxResolution: '4K', priceTier: 8,
  },
  'wan2.2-flash': {
    key: 'wan2.2-flash', label: '万相2.2 极速', modelId: 'wan2.2-t2i-flash',
    shape: 'A1', sizeKind: 'wh', modes: ['text2img'],
    maxImages: 4, maxInputImages: 0, maxResolution: '2K', priceTier: 3,
  },
  'qwen-image-edit': {
    key: 'qwen-image-edit', label: '图像编辑', modelId: 'qwen-image-edit',
    shape: 'S', sizeKind: 'wh', modes: ['img2img'],
    maxImages: 1, maxInputImages: 3, maxResolution: '2K', priceTier: 6,
  },
};

// 默认模型(老 job 无 model 字段、前端未传时兜底,C5b)。按 mode 分:
//   text2img → qwen-image(现状 A1);img2img → qwen-image-edit(现状 S 编辑,价 6)。
export const DEFAULT_IMAGE_MODEL = 'qwen-image';
export const DEFAULT_IMAGE_EDIT_MODEL = 'qwen-image-edit';

/** 取模型定义;未知/缺省 → 按 mode 选默认(C5b 老 job 兼容)。
 *  mode 仅在 key 缺省时用于选 text2img/img2img 默认;显式 key 优先。 */
export function getImageModel(key?: string, mode?: ImageMode): ImageModelDef {
  if (key && IMAGE_MODELS[key]) return IMAGE_MODELS[key]!;
  const fallback = mode === 'img2img' ? DEFAULT_IMAGE_EDIT_MODEL : DEFAULT_IMAGE_MODEL;
  return IMAGE_MODELS[fallback]!;
}

/** 分辨率档位排序,用于 maxResolution 上限校验。 */
const RES_ORDER: Record<string, number> = { '1K': 1, '2K': 2, '4K': 3 };
/** 该模型是否支持所选分辨率(4K 不支持→false,调用方 400,P2-4k 不 clamp)。 */
export function resolutionAllowed(def: ImageModelDef, resolution?: string): boolean {
  const want = RES_ORDER[resolution ?? '1K'] ?? 1;
  return want <= (RES_ORDER[def.maxResolution] ?? 2);
}

/**
 * 按 sizeKind 构建百炼 parameters 的 size 相关字段(P1-size)。
 *  - wh:      { size: "W*H" }(imageSize 映射)
 *  - keyword: { size: "1K"|"2K"|"4K" }(wan2.7 等)
 *  - aspect_res(本轮缓):{ aspect_ratio, resolution }(可灵)
 */
export function sizeParams(def: ImageModelDef, ratio?: string, resolution?: string): Record<string, string> {
  switch (def.sizeKind) {
    case 'wh':
      return { size: imageSize(ratio, resolution) };
    case 'keyword':
      return { size: (resolution ?? '2K').toUpperCase() };
    case 'aspect_res':
      // 缓:可灵接入时落地(aspect_ratio + resolution 小写档)。
      return { aspect_ratio: ratio ?? '1:1', resolution: (resolution ?? '1k').toLowerCase() };
    default:
      return { size: imageSize(ratio, resolution) };
  }
}
