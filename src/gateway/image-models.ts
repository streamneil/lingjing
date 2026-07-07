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
//   前端 fetch GET /image-models ──► 下拉(label/badge/modes;resolutionTiers=在售档,disabled 变体档已剔除 D5)
//          │ 用户选 modelKey
//          ▼
//   buildImageJob: getModel(key ?? 默认) ─► resolveImageRes(补默认档 D2 + 下架/档位校验)
//          ─► clamp(n,maxImages) ─► imagePriceTier(model_pricing 变体行 "{key}:{档}" → 基础价)─► 快照
//          │
//          ▼
//   worker: (registry[key].shape, mode)
//     ├ S + text2img → generateImageSync(纯文本 content)
//     ├ S + img2img  → editImage(含图 content)
//     └ A1 + text2img → submitImage → 轮询

import { imageSize } from './baichuan.js';
import { db, type ImageModelOverrideRow } from '../db/index.js';
import { lookupCost, sellPrice, variantId } from '../credits/pricing.js';

/** keyword 档集模型未传清晰度时的默认档(D2,2026-07):校验/生成/计费三层吃同一值。
 *  resolveImageRes(jobs.ts)与 sizeParams 共用此常量 —— 改默认档只动这里。 */
export const DEFAULT_KEYWORD_TIER = '2K';

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
  maxInputImages: number; // img2img 输入图上限(text2img 模型 0);上限受 /image-uploads 端点 maxCount=9 约束
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
  ratios?: string[]; // 该模型暴露的比例集(Gemini 等 keyword 模型用);缺省 → /image-models 派生回落(pixelMatrix 首档键 / keyword 空 / undefined)
  // ── token 计价模型(gpt-image-2,Design B 真实用量结算)──
  qualities?: string[]; // 画质档集(low/medium/high);有此字段 → 前端显画质选择器 + 提交带 quality
  priceRate?: number; // 每 output token 的真实成本元(¥/token)。有此字段 = token 计价模型(costFor 走用量结算分支,不用 priceTier)
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

// gpt-image-2 分辨率档 × 比例 → 精确像素(全部 ÷16、比例 ∈ [1:3,3:1]、≤3840×2160;OpenAI adapter 再转 `x` 分隔)。
// 1K = 官方标准尺寸(1024²等);2K/4K 按比例放大到 ≤上限。计价按真实 token 用量(Design B),与像素无直接系数。
const GPT_IMAGE2_PIXELS: Record<string, Record<string, string>> = {
  '1K': { '1:1': '1024*1024', '16:9': '1280*720', '9:16': '720*1280', '4:3': '1152*864', '3:4': '864*1152', '3:2': '1536*1024', '2:3': '1024*1536' },
  '2K': { '1:1': '2048*2048', '16:9': '2048*1152', '9:16': '1152*2048', '4:3': '2048*1536', '3:4': '1536*2048', '3:2': '2048*1360', '2:3': '1360*2048' },
  '4K': { '1:1': '2160*2160', '16:9': '3840*2160', '9:16': '2160*3840', '4:3': '2880*2160', '3:4': '2160*2880', '3:2': '3264*2160', '2:3': '2160*3264' },
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
  // 价:doc 估算价已由 seedPlatformDefaults 种入 model_pricing 并启用(全档扁价;火山实际按 token 计,
  // 各档真实成本核实 + 分档变体行见 TODOS T-SEEDREAM-TIER-PRICING)。此处 priceTier = 无行回落。
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
  // shape='S':同步生成(走 generateImageSync/editImage)。sizeKind='keyword':resolution→imageSize(512/1K/2K/4K)。
  // 文生图(text2img,0 图)+ 图生图/图片编辑/多图融合(img2img,1 主图 + 0..N 参考图,均同一 API 形状)。
  // 分辨率分档计价(2026-07,eng-review D1-D9):官方价随清晰度变,实收价 = model_pricing 变体行
  //   "{key}:{档}"(imagePriceTier 按所选档取,platform-defaults 种官方档价):
  //   Flash 512/1K/2K/4K = ¥0.32/0.48/0.73/1.09(积分 12/17/26/39);Pro 1K/2K/4K = ¥0.96/0.96/1.73(34/34/61)。
  //   此处 priceTier 常量 = 基础(2K)档回落价,真源在 model_pricing(mergeDef 无行才用它)。
  //   '512' 档已真实 API 实测(2026-07-04,imageSize='512' HTTP 200,D7)。
  'gemini-3.1-flash-image': {
    key: 'gemini-3.1-flash-image', label: 'Nano Banana 2 (Gemini 3.1 Flash)', modelId: 'gemini-3.1-flash-image', provider: 'google-ai-studio',
    shape: 'S', sizeKind: 'keyword', modes: ['text2img', 'img2img'],
    maxImages: 1, maxInputImages: 9, maxResolution: '4K', resolutionTiers: ['512', '1K', '2K', '4K'], priceTier: 26,
    ratios: ['1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1', '4:3', '4:5', '5:4', '8:1', '9:16', '16:9', '21:9'],
  },
  'gemini-3-pro-image': {
    key: 'gemini-3-pro-image', label: 'Nano Banana Pro (Gemini 3 Pro)', modelId: 'gemini-3-pro-image', provider: 'google-ai-studio',
    shape: 'S', sizeKind: 'keyword', modes: ['text2img', 'img2img'],
    maxImages: 1, maxInputImages: 6, maxResolution: '4K', resolutionTiers: ['1K', '2K', '4K'], priceTier: 34,
    ratios: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
  },

  // ── OpenAI GPT Image 2(第 4 个 provider,纯文生图,Design B token 计价)──
  // shape='S':同步生成(走 generateImageSync,openai.ts adapter)。sizeKind='wh':从 pixelMatrix 派生 WxH。
  // 三控:比例(ratios/pixelMatrix)+ 分辨率(resolutionTiers 1K/2K/4K)+ 画质(qualities)。
  // 计价:priceRate(¥/output token)→ costFor 走真实 usage 结算(reserve 高估→settle 按实封顶 reserved);
  //   不用 priceTier(此处 4 仅无 DB 行时的无意义回落,token 分支不读它)。真源 = model_pricing 单行(unit=token)。
  //   priceRate = $30/1M × 7.2 ≈ 0.000216 ¥/output token(OpenAI 文档 output image token 价)。
  // 文生图任意 WxH(1K/2K/4K);图片编辑走 /images/edits(仅 3 标准尺寸,openai adapter editSize 映射),
  // 输入图最多 9 张(受 /image-uploads maxCount=9 约束;OpenAI 侧上限 16)。编辑同 token 计价(usage 结算)。
  'gpt-image-2': {
    key: 'gpt-image-2', label: 'GPT Image 2', modelId: 'gpt-image-2-2026-04-21', provider: 'openai',
    shape: 'S', sizeKind: 'wh', modes: ['text2img', 'img2img'],
    maxImages: 1, maxInputImages: 9, maxResolution: '4K', resolutionTiers: ['1K', '2K', '4K'], priceTier: 4,
    pixelMatrix: GPT_IMAGE2_PIXELS,
    qualities: ['low', 'medium', 'high'],
    priceRate: 0.000216,
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
  // 无 override 行(model_pricing-only 模型,如 Gemini):售价同样以 model_pricing 为真源。
  // 2026-07 修脱钩(eng-review D8):此前直接返回代码模板,priceTier=硬编码常量,
  // admin 改价/改全局倍率对这类模型全部无效;现与 ov 分支同一算价路径(售价只在此处算)。
  const tmpl = IMAGE_MODELS[key];
  if (!tmpl) return undefined;
  const mp = lookupCost(key);
  return mp ? { ...tmpl, priceTier: sellPrice(mp.realCostYuan) } : tmpl;
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

/** 该模型当前在售的清晰度档集(D5,2026-07 分档计价)。
 *  变体行(model_pricing id="{key}:{档}")被 admin 禁用 = 该档下架 —— 从档集剔除,
 *  绝不回落基础价(否则「禁用 Pro:4K」变成按 2K 价卖 4K 图的亏本促销)。
 *  无变体行的档视为在售(存量模型/豆包不受影响);无 resolutionTiers 的模型返回 undefined。 */
export function enabledTiers(def: ImageModelDef): string[] | undefined {
  if (!def.resolutionTiers?.length) return undefined;
  return def.resolutionTiers.filter((t) => !tierDelisted(def.key, t));
}

/** 该(模型,档)是否被下架(变体行存在且 disabled,D5)。无变体行 = 在售(存量扁价模型不受影响)。
 *  resolveImageRes 的 resolutions 表分支也必须查它 —— 像素推档绕过 enabledTiers 会复活
 *  「禁用 4K 按 2K 价卖」的亏本促销(red-team 2026-07-05)。 */
export function tierDelisted(key: string, tier: string): boolean {
  const mp = lookupCost(variantId(key, tier));
  return !!mp && !mp.enabled;
}

/** 该模型是否支持所选分辨率。
 *  有 resolutionTiers(火山 seedream / Gemini)→ 在售档集成员校验(disabled 变体档已剔除,D5);
 *  否则旧「≤maxResolution」逻辑。全档下架 → 一律拒绝(不落回 maxResolution 旧逻辑)。 */
export function resolutionAllowed(def: ImageModelDef, resolution?: string): boolean {
  const tiers = enabledTiers(def);
  if (tiers) return tiers.length > 0 && tiers.includes(resolution ?? tiers[0]!);
  const want = RES_ORDER[resolution ?? '1K'] ?? 1;
  return want <= (RES_ORDER[def.maxResolution] ?? 2);
}

/** 从 def.pixelMatrix 按 (ratio, resolution) 派生精确 {width,height}(快照无关;pixelMatrix 是代码常量,无 mid-flight 漂移)。
 *  gpt-image-2 的 openai adapter 用它出 size(WxH,`x` 分隔);无 pixelMatrix / 解析失败 → undefined。
 *  档/比例缺省:回落首档 + 1:1(与 whSize 的 pixelMatrix 分支同口径)。 */
export function imagePixelWH(def: ImageModelDef, ratio?: string, resolution?: string): { width: number; height: number } | undefined {
  if (!def.pixelMatrix) return undefined;
  const tiers = Object.keys(def.pixelMatrix);
  const tier = resolution && def.pixelMatrix[resolution] ? resolution : tiers[0]!;
  const byRatio = def.pixelMatrix[tier]!;
  const px = byRatio[ratio ?? '1:1'] ?? byRatio['1:1'] ?? Object.values(byRatio)[0];
  if (!px) return undefined;
  const [w, h] = px.split('*').map((s) => Number(s));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w! <= 0 || h! <= 0) return undefined;
  return { width: w!, height: h! };
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
 *  - keyword: { size: "512"|"1K"|"2K"|"3K"|"4K" }(万相2.7 / 豆包 seedream;Gemini 走自家网关不经此)
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
      return { size: (resolution ?? DEFAULT_KEYWORD_TIER).toUpperCase() };
    case 'aspect_res':
      // 缓:可灵接入时落地(aspect_ratio + resolution 小写档)。
      return { aspect_ratio: ratio ?? '1:1', resolution: (resolution ?? '1k').toLowerCase() };
    default:
      return { size: whSize(def, ratio, resolution, snap) };
  }
}

// ── 默认图片模型种子(开箱即完整)──────────────────────────────────────────
// 背景:isEnabled() 要求 DB 行(model_pricing / image_model_override),无行 = 不启用。
// 代码内置的 IMAGE_MODELS 若没对应 DB 行,前端「AI 图片/编辑器」下拉就"暂无可用模型"。
// 这批默认行以前只在 scripts/seed-demo.mjs(开发种子)里,生产 deploy.sh 不跑 → 线上空。
// 故抽成本函数,由 app 启动时自动灌(server.ts,表空才灌、幂等、不覆盖 admin 改过的),
// 与默认积分套餐同理。seed-demo.mjs 也复用本函数(单一真源)。
// 数值来源:2026-06 价格页;price_tier = ceil(真实元/张 × 35),cost_source=doc。
export const DEFAULT_IMAGE_MODEL_SEED: [string, string, string, number, number, number, string, string, number][] = [
  // key, label, modelId, priceTier, realCost, maxImages, shapeTemplate, modes, sortOrder
  ['qwen-image',        '标准',              'qwen-image',         9,  0.25, 1, 'qwen-image',         'text2img',          0],
  ['z-image',           '极速',              'z-image-turbo',      4,  0.10, 1, 'z-image',            'text2img',          1],
  ['qwen-image-2.0',    '千问2.0',           'qwen-image-2.0',     7,  0.20, 6, 'qwen-image-2.0-pro', 'text2img',          2],
  ['qwen-image-2.0-pro','专业 (千问2.0 Pro)', 'qwen-image-2.0-pro', 18, 0.50, 6, 'qwen-image-2.0-pro', 'text2img,img2img',  3],
  ['qwen-image-edit',   '图像编辑',           'qwen-image-edit',    11, 0.30, 1, 'qwen-image-edit',    'img2img',           5],
  ['wan2.2-flash',      '万相2.2 极速',       'wan2.2-t2i-flash',   5,  0.14, 4, 'wan2.2-flash',       'text2img',          6],
  ['wan2.7-image',      '万相2.7 编辑',       'wan2.7-image',       7,  0.20, 4, 'wan2.7-image',       'text2img,img2img',  7],
  ['wan2.7-image-pro',  '万相2.7 编辑 Pro',   'wan2.7-image-pro',   18, 0.50, 4, 'wan2.7-image-pro',   'text2img,img2img',  8],
];

/** 灌默认图片模型(幂等:逐 key,已存在则跳过,绝不覆盖 admin 改过的)。返回新建数量。 */
export function seedDefaultImageModels(): number {
  const exists = db.prepare('SELECT 1 FROM image_model_override WHERE key=?');
  const ins = db.prepare(
    `INSERT INTO image_model_override
       (key,label,model_id,enabled,price_tier,real_cost_yuan,cost_source,max_images,shape_template,modes,sort_order,created_at)
     VALUES (?,?,?,1,?,?,'doc',?,?,?,?,?)`,
  );
  let n = 0;
  const now = Date.now();
  for (const [key, label, modelId, tier, cost, maxImg, tmpl, modes, sort] of DEFAULT_IMAGE_MODEL_SEED) {
    if (exists.get(key)) continue;
    ins.run(key, label, modelId, tier, cost, maxImg, tmpl, modes, sort, now);
    n++;
  }
  return n;
}
