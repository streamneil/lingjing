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
  modelId: string; // 厂商实际 model 名(豆包如 doubao-seedream-4.0)
  provider?: string; // 接入厂商(model-access-platform PR-2a);缺省 'bailian'。豆包='volc-ark'。
  shape: ImageShape;
  sizeKind: SizeKind;
  modes: ImageMode[]; // 支持的模式
  maxImages: number; // 出图张数上限(z-image 固定1、qwen-2.0 6)
  maxInputImages: number; // img2img 输入图上限(text2img 模型 0);v1 封顶 3(上传端点写死,P2-c)
  maxResolution: '1K' | '2K' | '4K'; // 最高分辨率档
  // 该模型支持的清晰度档集(精确,非「≤maxResolution」)。火山 seedream 各型号档不同:
  //   5.0-lite=2K/3K/4K、4.5=2K/4K、4.0=1K/2K/4K(跳档,maxResolution 表达不了)。
  //   空 → 前端回落 ['1K','2K','4K'].filter(≤maxResolution) 旧逻辑。
  resolutionTiers?: string[];
  priceTier: number; // 每张计价(替代 PRICE_PER_IMAGE,非双乘 P2-a)
  resolutions?: ResolutionEntry[]; // admin 录的分辨率列表(百炼官方推荐表);空 → 用 imageSize 算
  // 精确像素矩阵(tier → ratio → "W*H")。模型官方给「档×比例→推荐像素」时用它,
  //   whSize 直接查表发官方推荐尺寸,不走偏小的通用公式。z-image 文档即此形态。
  //   UI 档(1K/2K)映射到表内 tier:见各模型注释。
  pixelMatrix?: Record<string, Record<string, string>>;
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
// z-image 官方推荐分辨率(文档「size参数设置」)。tier 映射:UI 1K→1024 tier、2K→1536 tier(最高推荐档)。
// 仅收平台 7 个标准比例(文档还有 7:9/9:7/9:21/21:9,UI 未暴露,略)。
const ZIMAGE_PIXELS: Record<string, Record<string, string>> = {
  '1K': { '1:1': '1024*1024', '16:9': '1280*720', '9:16': '720*1280', '4:3': '1152*864', '3:4': '864*1152', '3:2': '1248*832', '2:3': '832*1248' },
  '2K': { '1:1': '1536*1536', '16:9': '2048*1152', '9:16': '1152*2048', '4:3': '1728*1296', '3:4': '1296*1728', '3:2': '1872*1248', '2:3': '1248*1872' },
};

// 千问 2.0 系列(qwen-image-2.0 / qwen-image-2.0-pro)官方「常见比例推荐分辨率」表。
// 文档:总像素 512²~2048²,默认接近 1024²,指定 size 时系统调到最近的 16 倍数。
// UI 档:1K→左列(~1024²)、2K→右列(更大,~1536²/官方推荐高分)。8 比例覆盖平台全部档位。
const QWEN20_PIXELS: Record<string, Record<string, string>> = {
  '1K': { '1:1': '1024*1024', '2:3': '768*1152', '3:2': '1152*768', '3:4': '960*1280', '4:3': '1280*960', '9:16': '720*1280', '16:9': '1280*720', '21:9': '1344*576' },
  '2K': { '1:1': '1536*1536', '2:3': '1024*1536', '3:2': '1536*1024', '3:4': '1080*1440', '4:3': '1440*1080', '9:16': '1080*1920', '16:9': '1920*1080', '21:9': '2048*872' },
};

export const IMAGE_MODELS: Record<string, ImageModelDef> = {
  // priceTier 默认 = 真实单价×35(无 DB row 时回落用;DB override 赢)。z-image 关改写 0.1→4。
  // pixelMatrix:官方推荐尺寸表(替代偏小的通用公式,16:9 从 1024×576 修到 1280×720 等)。
  'z-image': {
    key: 'z-image', label: '极速', modelId: 'z-image-turbo',
    shape: 'S', sizeKind: 'wh', modes: ['text2img'],
    maxImages: 1, maxInputImages: 0, maxResolution: '2K', priceTier: 4,
    pixelMatrix: ZIMAGE_PIXELS,
  },
  // qwen-image 固定 1 张(文档:n>1 报 num_images_per_prompt must be 1)。0.25→9。
  'qwen-image': {
    key: 'qwen-image', label: '标准', modelId: 'qwen-image',
    shape: 'A1', sizeKind: 'wh', modes: ['text2img'],
    maxImages: 1, maxInputImages: 0, maxResolution: '2K', priceTier: 9,
  },
  // 2.0 Pro 真实分辨率上限 2048²≈2K(不是 4K;文档:size 总像素 512²~2048²)。0.5→18。
  // pixelMatrix:官方「常见比例推荐分辨率」表(档×比例→精确像素),前端比例选项 + 后端发对齐尺寸。
  // qwen-image-2.0(DB override,shape_template=本模板)经 mergeDef ...tmpl 自动继承此 pixelMatrix。
  'qwen-image-2.0-pro': {
    key: 'qwen-image-2.0-pro', label: '专业 (千问2.0 Pro)', modelId: 'qwen-image-2.0-pro',
    shape: 'S', sizeKind: 'wh', modes: ['text2img', 'img2img'],
    maxImages: 6, maxInputImages: 3, maxResolution: '2K', priceTier: 18,
    pixelMatrix: QWEN20_PIXELS,
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
  // size 为 keyword 档(1K/2K),输出比例随输入图自动决定(用户不选比例;sizeParams 对 keyword 丢弃 ratio)。
  'wan2.7-image': {
    key: 'wan2.7-image', label: '万相2.7 编辑', modelId: 'wan2.7-image',
    shape: 'A_EDIT', sizeKind: 'keyword', modes: ['text2img', 'img2img'],
    maxImages: 4, maxInputImages: 5, maxResolution: '2K', resolutionTiers: ['1K', '2K'], priceTier: 7, supportsBbox: true,
  },
  // Pro 按官方文档支持 1K/2K/4K(文生图到 4K;编辑场景厂商接受 1K/2K/4K size 档,本平台开放全档)。
  'wan2.7-image-pro': {
    key: 'wan2.7-image-pro', label: '万相2.7 编辑 Pro', modelId: 'wan2.7-image-pro',
    shape: 'A_EDIT', sizeKind: 'keyword', modes: ['text2img', 'img2img'],
    // 真实成本 0.50 元/张 × 35 = 18(原 10 是偏低占位,会亏:只收 2 倍成本而非 3.5 倍)。
    maxImages: 4, maxInputImages: 5, maxResolution: '4K', resolutionTiers: ['1K', '2K', '4K'], priceTier: 18, supportsBbox: true,
  },

  // ── 火山引擎 豆包 Seedream(PR-2a;provider='volc-ark',走 ark.ts SyncImageGateway)──
  // shape='S':同步生成(走 generateImageSync/editImage,与百炼 S 形状同 worker 路径)。
  // sizeKind='keyword':size 传 '2K'/'4K' 档(ark 适配器透传)。文生图 + 多图融合(img2img)。
  // ⚠ 价格未录(火山按 token 计)→ priceTier 占位、admin 录真实成本前不启用。
  // 火山真实固定价(元/张):4.0=0.2→⌈×35⌉=7;4.5=0.25→9;5.0-lite=0.22→8(model_pricing 为准)。
  // resolutionTiers:火山文档精确档集(各型号不同);ark 适配器按 (型号,档,比例) 查像素表发精确 size。
  'doubao-seedream-4.0': {
    key: 'doubao-seedream-4.0', label: '豆包 Seedream 4.0', modelId: 'doubao-seedream-4-0-250828', provider: 'volc-ark',
    shape: 'S', sizeKind: 'keyword', modes: ['text2img', 'img2img'],
    maxImages: 1, maxInputImages: 5, maxResolution: '4K', resolutionTiers: ['1K', '2K', '4K'], priceTier: 7,
  },
  'doubao-seedream-4.5': {
    key: 'doubao-seedream-4.5', label: '豆包 Seedream 4.5', modelId: 'doubao-seedream-4-5-251128', provider: 'volc-ark',
    shape: 'S', sizeKind: 'keyword', modes: ['text2img', 'img2img'],
    maxImages: 1, maxInputImages: 5, maxResolution: '4K', resolutionTiers: ['2K', '4K'], priceTier: 9,
  },
  'doubao-seedream-5.0-lite': {
    key: 'doubao-seedream-5.0-lite', label: '豆包 Seedream 5.0 Lite', modelId: 'doubao-seedream-5-0-260128', provider: 'volc-ark',
    shape: 'S', sizeKind: 'keyword', modes: ['text2img', 'img2img'],
    maxImages: 1, maxInputImages: 5, maxResolution: '4K', resolutionTiers: ['2K', '3K', '4K'], priceTier: 8,
  },

  // ── Google AI Studio Gemini(Nano Banana,文档收口:只用这 2 个模型)──
  // shape='S':同步生成(走 generateImageSync/editImage)。sizeKind='keyword':resolution→imageSize(1K/2K/4K)。
  // 文生图(text2img,0 图)+ 图生图/图片编辑/多图融合(img2img,1 主图 + 0..N 参考图,均同一 API 形状)。
  // 真实价(美元×7.2 汇率,2K 档单一计价;后期分辨率分档见 TODOS):
  //   3.1 Flash 2K $0.101→0.73元→⌈×35⌉=26;3 Pro 1–2K $0.134→0.96元→34。
  'gemini-3.1-flash-image': {
    key: 'gemini-3.1-flash-image', label: 'Nano Banana 2 (Gemini 3.1 Flash)', modelId: 'gemini-3.1-flash-image', provider: 'google-ai-studio',
    shape: 'S', sizeKind: 'keyword', modes: ['text2img', 'img2img'],
    maxImages: 1, maxInputImages: 10, maxResolution: '4K', resolutionTiers: ['1K', '2K', '4K'], priceTier: 26,
  },
  'gemini-3-pro-image': {
    key: 'gemini-3-pro-image', label: 'Nano Banana Pro (Gemini 3 Pro)', modelId: 'gemini-3-pro-image', provider: 'google-ai-studio',
    shape: 'S', sizeKind: 'keyword', modes: ['text2img', 'img2img'],
    maxImages: 1, maxInputImages: 6, maxResolution: '4K', resolutionTiers: ['1K', '2K', '4K'], priceTier: 34,
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
const RES_ORDER: Record<string, number> = { '1K': 1, '2K': 2, '3K': 3, '4K': 4 };
/** 该模型是否支持所选分辨率。
 *  有 resolutionTiers(火山 seedream)→ 精确档集成员校验(3K/跳档可表达);否则旧「≤maxResolution」逻辑。 */
export function resolutionAllowed(def: ImageModelDef, resolution?: string): boolean {
  if (def.resolutionTiers?.length) return def.resolutionTiers.includes(resolution ?? def.resolutionTiers[0]!);
  const want = RES_ORDER[resolution ?? '1K'] ?? 1;
  return want <= (RES_ORDER[def.maxResolution] ?? 2);
}

/** wh 模型查 def.resolutions 得 "W*H"(不再 imageSize 猜);snap 是 buildImageJob 写的快照,优先。 */
function whSize(def: ImageModelDef, ratio?: string, resolution?: string, snap?: { width?: number; height?: number }): string {
  // 1. 快照优先(P1-c:admin mid-flight 改不影响在飞 job)。
  if (snap && Number.isFinite(snap.width) && Number.isFinite(snap.height)) return `${snap.width}*${snap.height}`;
  // 2. 官方像素矩阵(tier×ratio→精确推荐尺寸,如 z-image)。档/比例缺省回落首档+1:1。
  if (def.pixelMatrix) {
    const tiers = Object.keys(def.pixelMatrix);
    const tier = resolution && def.pixelMatrix[resolution] ? resolution : tiers[0]!;
    const byRatio = def.pixelMatrix[tier]!;
    return byRatio[ratio ?? '1:1'] ?? byRatio['1:1'] ?? Object.values(byRatio)[0]!;
  }
  // 3. 查 admin 录的分辨率表(官方推荐,不猜)。
  if (def.resolutions?.length) {
    const hit = def.resolutions.find((r) => r.ratio === (ratio ?? '1:1')) ?? def.resolutions.find((r) => r.isDefault) ?? def.resolutions[0];
    if (hit) return `${hit.width}*${hit.height}`;
  }
  // 4. 回落 imageSize 算(老 job/未配模型兼容)。
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
