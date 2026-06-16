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
import { db, type ImageModelOverrideRow } from '../db/index.js';
import { lookupCost, sellPrice } from '../credits/pricing.js';

export type ImageShape = 'S' | 'A1' | 'A2' | 'A_EDIT'; // S=同步多模态 A1=异步文生图 A2=异步图生成(缓) A_EDIT=异步含图编辑(万相2.7)
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
  resolutions?: ResolutionEntry[]; // admin 录的分辨率列表(百炼官方推荐表);空 → 用 imageSize 算
  supportsBbox?: boolean; // 支持 bbox_list 局部重绘(仅万相2.7;千问编辑不支持)
  canSetSize?: boolean; // 是否可指定分辨率(缺省 true);false=随输入图(qwen-image-edit),UI 隐藏清晰度控件 + 提交不发 size
}

// 分辨率条目(admin 照百炼文档录 比例:宽*高;tier 计价档由像素自动推,不存)。
export interface ResolutionEntry {
  ratio: string; // '16:9' / '1:1' ...
  width: number;
  height: number;
  isDefault?: boolean;
}

// 像素总量 → 计价档(tier):≤1.3MP(~1280²)=1K、≤3MP(~2048²)=2K、>3MP=4K。
// 让 admin 只录宽高,tier 自动算(钱不塌:计价仍按真实像素档)。
export function tierFromPixels(width: number, height: number): '1K' | '2K' | '4K' {
  const mp = (width * height) / 1_000_000;
  if (mp <= 1.3) return '1K';
  if (mp <= 3) return '2K';
  return '4K';
}

// 精选 5 模型(全 S/A1,代码现成)。modelId 按用户给的百炼文档核实。
export const IMAGE_MODELS: Record<string, ImageModelDef> = {
  // priceTier 默认 = 真实单价×35(无 DB row 时回落用;DB override 赢)。z-image 关改写 0.1→4。
  'z-image': {
    key: 'z-image', label: '极速', modelId: 'z-image-turbo',
    shape: 'S', sizeKind: 'wh', modes: ['text2img'],
    maxImages: 1, maxInputImages: 0, maxResolution: '2K', priceTier: 4,
  },
  // qwen-image 固定 1 张(文档:n>1 报 num_images_per_prompt must be 1)。0.25→9。
  'qwen-image': {
    key: 'qwen-image', label: '标准', modelId: 'qwen-image',
    shape: 'A1', sizeKind: 'wh', modes: ['text2img'],
    maxImages: 1, maxInputImages: 0, maxResolution: '2K', priceTier: 9,
  },
  // 2.0 Pro 真实分辨率上限 2048²≈2K(不是 4K;文档:size 总像素 512²~2048²)。0.5→18。
  'qwen-image-2.0-pro': {
    key: 'qwen-image-2.0-pro', label: '专业 (千问2.0 Pro)', modelId: 'qwen-image-2.0-pro',
    shape: 'S', sizeKind: 'wh', modes: ['text2img', 'img2img'],
    maxImages: 6, maxInputImages: 3, maxResolution: '2K', priceTier: 18,
  },
  'wan2.2-flash': {
    key: 'wan2.2-flash', label: '万相2.2 极速', modelId: 'wan2.2-t2i-flash',
    shape: 'A1', sizeKind: 'wh', modes: ['text2img'],
    maxImages: 4, maxInputImages: 0, maxResolution: '2K', priceTier: 5,
  },
  // 编辑:固定 1 张,分辨率不可指定(canSetSize=false;随输入图)。0.3→11。
  'qwen-image-edit': {
    key: 'qwen-image-edit', label: '图像编辑', modelId: 'qwen-image-edit',
    shape: 'S', sizeKind: 'wh', modes: ['img2img'],
    maxImages: 1, maxInputImages: 3, maxResolution: '2K', priceTier: 11, canSetSize: false,
  },
  // 万相2.7 编辑(异步含图,A_EDIT):支持 bbox_list 局部重绘 + 0-5 参考图 + n=1-4 出图。
  // size 走 keyword(编辑封顶 2K);提交 /image-generation/generation + X-DashScope-Async,轮询 /tasks/{id}。
  'wan2.7-image': {
    key: 'wan2.7-image', label: '万相2.7 编辑', modelId: 'wan2.7-image',
    shape: 'A_EDIT', sizeKind: 'keyword', modes: ['text2img', 'img2img'],
    maxImages: 4, maxInputImages: 5, maxResolution: '2K', priceTier: 7, supportsBbox: true,
  },
  'wan2.7-image-pro': {
    key: 'wan2.7-image-pro', label: '万相2.7 编辑 Pro', modelId: 'wan2.7-image-pro',
    shape: 'A_EDIT', sizeKind: 'keyword', modes: ['text2img', 'img2img'],
    // 真实成本 0.50 元/张 × 35 = 18(原 10 是偏低占位,会亏:只收 2 倍成本而非 3.5 倍)。
    maxImages: 4, maxInputImages: 5, maxResolution: '2K', priceTier: 18, supportsBbox: true,
  },
};

// 默认模型(老 job 无 model 字段、前端未传时兜底,C5b)。按 mode 分:
//   text2img → qwen-image(现状 A1);img2img → qwen-image-edit(现状 S 编辑,价 6)。
export const DEFAULT_IMAGE_MODEL = 'qwen-image';
export const DEFAULT_IMAGE_EDIT_MODEL = 'qwen-image-edit';

// ── DB 覆盖层(CEO A2:代码拥有技术契约,DB 只覆盖展示/运营字段)──
// 惰性 prepare(P1-lazy:绝不在模块顶 prepare,否则 image-models 早于 db CREATE TABLE 加载会 no-such-table)。
let _ovStmt: import('better-sqlite3').Statement | null = null;
function overrideRow(key: string): ImageModelOverrideRow | undefined {
  _ovStmt ??= db.prepare('SELECT * FROM image_model_override WHERE key = ?');
  return _ovStmt.get(key) as ImageModelOverrideRow | undefined;
}

/** 合并:技术契约从代码(按 shape_template ?? key),展示/运营字段从 DB override(若有)。 */
function mergeDef(key: string): ImageModelDef | undefined {
  const ov = overrideRow(key);
  if (ov) {
    // 技术字段从代码模板取(A2 + A5:新增模型用 shape_template 指向代码模板)。
    const tmpl = IMAGE_MODELS[ov.shape_template ?? key];
    if (!tmpl) return undefined; // 模板丢失(不该发生:模板是代码 key)
    // modes:管理员勾选的优先(用户选了「完全自由勾」);空 → 回落代码模板 modes。
    const ovModes = (ov.modes ?? '').split(',').map((s) => s.trim()).filter((s): s is ImageMode => s === 'text2img' || s === 'img2img');
    // 价格收口(2026-06 统一定价):售价唯一真源 = model_pricing(lookupCost→sellPrice,接全局倍率)。
    //   ov.price_tier 不再读(双源根已切断);仅当 model_pricing 无此行(迁移前/未录价)才回落旧列兜底。
    const mp = lookupCost(key);
    const priceTier = mp ? sellPrice(mp.realCostYuan) : ov.price_tier;
    const def: ImageModelDef = {
      ...tmpl, // shape/sizeKind/maxResolution/maxInputImages(技术契约)
      key,
      label: ov.label,
      modelId: ov.model_id,
      maxImages: ov.max_images,
      priceTier,
      modes: ovModes.length ? ovModes : tmpl.modes, // 管理员勾选优先
    };
    const res = parseResolutions(ov.resolutions); // JSON 坏数据回落 undefined(P2-c)
    if (res) def.resolutions = res;
    return def;
  }
  return IMAGE_MODELS[key];
}

// 解析 resolutions JSON(热路径:worker/credits/下拉都过 mergeDef → 坏 JSON 绝不抛,P2-c)。
function parseResolutions(raw: string | null): ResolutionEntry[] | undefined {
  if (!raw) return undefined;
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length === 0) return undefined;
    const ok = arr.filter(
      (r): r is ResolutionEntry =>
        r && typeof r.ratio === 'string' && Number.isFinite(r.width) && Number.isFinite(r.height) && r.width > 0 && r.height > 0,
    );
    return ok.length ? ok : undefined;
  } catch {
    return undefined; // 坏 JSON → 回落代码默认
  }
}

/** 模型是否启用(DB override 优先;无 override 视为启用)。 */
// 启用唯一真源 = DB override 行(2026-06 修「默认即启用」地雷):
// 旧逻辑 `ov ? ... : !!IMAGE_MODELS[key]` 让无 override 行的代码模板模型默认上线,
// wan2.7-image-pro 就是这样静默启用带占位价。现在:无 override 行 = 不启用。
// 注意:这只管「是否出现在 listEnabledModels / 默认兜底」;getImageModel(显式 key)仍返回
// disabled 模型(在飞/老 job 兼容,见 getImageModel)。
function isEnabled(key: string): boolean {
  // 启停收口(2026-06 统一定价,eng-review E2):启用唯一真源 = model_pricing.enabled。
  //   仅当 model_pricing 无此行(迁移前/未录价)才回落 image_model_override.enabled 兜底。
  //   无任何行 → 不启用(防占位价静默上线;沿用「无行=不启用」语义)。
  const mp = lookupCost(key);
  if (mp) return mp.enabled;
  const ov = overrideRow(key);
  return ov ? ov.enabled === 1 : false;
}

/** 取模型定义(代码 + DB override 合并);未知/缺省 → 按 mode 选默认。
 *  外部声音 P1-default:默认模型若被 admin 禁用,跳到首个 enabled,再不行用纯代码常量
 *  (in-flight/老 job 显式取 disabled 仍允许 —— 只有「默认兜底」必须 enabled)。 */
export function getImageModel(key?: string, mode?: ImageMode): ImageModelDef {
  if (key) {
    const m = mergeDef(key);
    if (m) return m; // 显式 key:允许 disabled(在飞/老 job 兼容)
  }
  // 缺省兜底:先试 mode 默认,禁用则跳首个 enabled,再不行纯代码常量。
  const prefer = mode === 'img2img' ? DEFAULT_IMAGE_EDIT_MODEL : DEFAULT_IMAGE_MODEL;
  if (isEnabled(prefer)) return mergeDef(prefer) ?? IMAGE_MODELS[prefer]!;
  const firstEnabled = Object.keys(IMAGE_MODELS).find(
    (k) => isEnabled(k) && IMAGE_MODELS[k]!.modes.includes(mode === 'img2img' ? 'img2img' : 'text2img'),
  );
  return firstEnabled ? mergeDef(firstEnabled)! : IMAGE_MODELS[prefer]!; // 全禁用 → 纯代码默认(不让系统瘫)
}

/** 该 key 是否已知模型(代码内置 或 DB 新增)。buildImageJob 白名单校验用。 */
export function isKnownModel(key: string): boolean {
  return !!IMAGE_MODELS[key] || !!overrideRow(key);
}

/** 用户端可选模型(只列 enabled;DB override 优先;按 sort_order 排序)。admin 管理视图另走 admin.ts。 */
export function listEnabledModels(): ImageModelDef[] {
  // 代码 key + DB 新增 key 的并集,过滤 enabled。
  const codeKeys = Object.keys(IMAGE_MODELS);
  const ovRows = db.prepare('SELECT key, sort_order FROM image_model_override').all() as { key: string; sort_order: number }[];
  const sortByKey = new Map(ovRows.map((r) => [r.key, r.sort_order]));
  const keys = Array.from(new Set([...codeKeys, ...ovRows.map((r) => r.key)]));
  const codeOrder = new Map(codeKeys.map((k, i) => [k, i])); // 代码内置默认顺序(无 override 时)
  return keys
    .filter(isEnabled)
    .sort((a, b) => (sortByKey.get(a) ?? codeOrder.get(a) ?? 999) - (sortByKey.get(b) ?? codeOrder.get(b) ?? 999))
    .map((k) => mergeDef(k))
    .filter((d): d is ImageModelDef => !!d);
}

/** 分辨率档位排序,用于 maxResolution 上限校验。 */
const RES_ORDER: Record<string, number> = { '1K': 1, '2K': 2, '4K': 3 };
/** 该模型是否支持所选分辨率(4K 不支持→false,调用方 400,P2-4k 不 clamp)。 */
export function resolutionAllowed(def: ImageModelDef, resolution?: string): boolean {
  const want = RES_ORDER[resolution ?? '1K'] ?? 1;
  return want <= (RES_ORDER[def.maxResolution] ?? 2);
}

/** wh 模型查 def.resolutions 得 "W*H"(不再 imageSize 猜);snap 是 buildImageJob 写的快照,优先。 */
function whSize(def: ImageModelDef, ratio?: string, resolution?: string, snap?: { width?: number; height?: number }): string {
  // 1. 快照优先(P1-c:admin mid-flight 改不影响在飞 job)。
  if (snap && Number.isFinite(snap.width) && Number.isFinite(snap.height)) return `${snap.width}*${snap.height}`;
  // 2. 查 admin 录的分辨率表(官方推荐,不猜)。
  if (def.resolutions?.length) {
    const hit = def.resolutions.find((r) => r.ratio === (ratio ?? '1:1')) ?? def.resolutions.find((r) => r.isDefault) ?? def.resolutions[0];
    if (hit) return `${hit.width}*${hit.height}`;
  }
  // 3. 回落 imageSize 算(老 job/未配模型兼容)。
  return imageSize(ratio, resolution);
}

/**
 * 按 sizeKind 构建百炼 parameters 的 size 相关字段(P1-size)。
 *  - wh:      { size: "W*H" }(快照 → resolutions 表 → imageSize 回落)
 *  - keyword: { size: "1K"|"2K"|"4K" }(wan2.7 等;现无活模型)
 *  - aspect_res(本轮缓):{ aspect_ratio, resolution }(可灵)
 */
export function sizeParams(
  def: ImageModelDef,
  ratio?: string,
  resolution?: string,
  snap?: { width?: number; height?: number },
): Record<string, string> {
  // canSetSize=false(qwen-image-edit:输出随输入图,文档不可指定 size)→ 不拼 size 参数,
  // 与前端隐藏清晰度控件双保险(否则发了无效 size 可能报错/被忽略)。
  if (def.canSetSize === false) return {};
  switch (def.sizeKind) {
    case 'wh':
      return { size: whSize(def, ratio, resolution, snap) };
    case 'keyword':
      return { size: (resolution ?? '2K').toUpperCase() };
    case 'aspect_res':
      // 缓:可灵接入时落地(aspect_ratio + resolution 小写档)。
      return { aspect_ratio: ratio ?? '1:1', resolution: (resolution ?? '1k').toLowerCase() };
    default:
      return { size: whSize(def, ratio, resolution, snap) };
  }
}
