// 灵镜 文生视频模型注册表 —— 单一真相源(前端下拉 + worker dispatch + 计价 + 校验全读它)。
//
// 决策来源:/plan-ceo-review(HOLD SCOPE)+ /plan-eng-review + /plan-design-review。
// 核心洞察:三家文生视频模型,请求体形状只有 2 种(V_DASH / V_KLING),都异步轮询 /tasks/{id}。
//
// ⚠️ 两个非显然维度(spec review R3 + 文档核实):
//  - paramShape(R3):参数形状在 shape 内不同。
//    V_DASH(happyhorse/wan2.7)= resolution(720P/1080P)+ ratio + duration;
//    V_KLING(可灵)= mode(std/pro)+ aspect_ratio + duration + audio,且 modelId 带 'kling/' 前缀。
//    可灵无 resolution 字段 → buildVideoT2VJob 把 mode 翻译成 resSnapshot(std→720P/pro→1080P),
//    计价键统一按 res 字面量(R3)。
//  - maxPromptChars(R4):逐模型字数上限(happyhorse「5000非中/2500中」本轮取 2500 安全下限,
//    不做 CJK 拆分;wan2.7 5000;可灵 2500)。reserve 前校验,超限 400。
//
//        模型选择数据流
//   前端 fetch GET /video-models ──► 下拉(label/能力标志)
//          │ 用户选 modelKey
//          ▼
//   buildVideoT2VJob: getVideoModel(key) ─► 校验 res/ratio/duration/mode/audio/prompt 字数
//                                          ─► clamp duration ─► 快照(dur/res/audio/priceTier)
//          │
//          ▼
//   worker: registry[key].shape
//     ├ V_DASH  → submitVideoT2V(resolution+ratio 体)→ 轮询 /tasks/{id}
//     └ V_KLING → submitVideoT2V(mode+aspect_ratio+audio 体, kling/ 前缀)→ 轮询 /tasks/{id}
//
// DB 审计:本轮无 DB override 表(技术契约全在代码,比图片更简单;后续 admin 需要再加,同图片起步)。

export type VideoShape = 'V_DASH' | 'V_KLING'; // V_DASH=百炼原生(res+ratio) V_KLING=可灵(mode+aspect_ratio+audio)
// i2v media 任务(图转影片):first_frame=首帧、first_last=首尾帧、reference=参考生(多图)。
// t2v(文生视频)模型 tasks 为空。
export type VideoTask = 'first_frame' | 'first_last' | 'reference';

export interface VideoModelDef {
  key: string; // 内部 key(input.model 存它)
  label: string; // UI 标签
  modelId: string; // 百炼实际 model 名(可灵带 'kling/' 前缀)
  shape: VideoShape;
  resolutions: ('720P' | '1080P')[]; // 支持的分辨率档(可灵经 mode 映射:std→720P、pro→1080P)
  ratios: string[]; // 支持的宽高比(i2v 首帧/首尾帧跟首帧自动 → 空数组)
  durationRange: [number, number]; // [最短, 最长] 秒
  defaultDuration: number; // 默认时长
  maxPromptChars: number; // 提示词字数上限(逐模型,reserve 前校验)
  priceTier: number; // 每秒计价基数(estimateVideoCost:ceil(duration × priceTier × resFactor))
  supportsAudio: boolean; // 支持有声视频(audio 布尔;本轮仅可灵开关可见,见 design D4/R6)
  supportsNegative: boolean; // 支持反向提示词(仅 wan2.7)
  supportsPromptExtend: boolean; // 支持 prompt 智能改写(仅 wan2.7)
  // ── 图转影片(i2v)──
  tasks: VideoTask[]; // 支持的 media 任务(t2v 模型为 []);前端按此显隐 tab
  maxRefImages?: number; // 参考生(reference task)参考图上限(HappyHorse-r2v 9、wan2.7-r2v 5)
  promptRequired?: boolean; // prompt 必填(参考生 true;首帧/首尾帧可选)
}

// 三模型(纯文生视频打平)。modelId 按用户给的百炼文档核实。
export const VIDEO_MODELS: Record<string, VideoModelDef> = {
  // HappyHorse:物理真实、运动流畅。无 audio/negative/prompt_extend。ratios 全 9 档。
  'happyhorse-1.0-t2v': {
    key: 'happyhorse-1.0-t2v', label: 'HappyHorse 1.0', modelId: 'happyhorse-1.0-t2v',
    shape: 'V_DASH',
    resolutions: ['720P', '1080P'],
    ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '4:5', '5:4', '9:21', '21:9'],
    durationRange: [3, 15], defaultDuration: 5,
    maxPromptChars: 2500, // 文档「5000非中/2500中」→ 取安全下限(不做 CJK 拆分,本轮缓)
    priceTier: 3,
    supportsAudio: false, supportsNegative: false, supportsPromptExtend: false,
    tasks: [], // t2v:无 media 任务
  },
  // 万相2.7:大师模型,支持音频生成/反向提示词/prompt 智能改写。res 720P/1080P。
  // 注:audio 本轮靠 audio_url 上传(已缓,前端不暴露)→ supportsAudio 标 false,无可见开关(R6)。
  'wan2.7-t2v': {
    key: 'wan2.7-t2v', label: '大师 (万相2.7)', modelId: 'wan2.7-t2v',
    shape: 'V_DASH',
    resolutions: ['720P', '1080P'],
    ratios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    durationRange: [2, 15], defaultDuration: 5,
    maxPromptChars: 5000,
    priceTier: 5,
    supportsAudio: false, // R6:audio_url 上传缓做,本轮无可见 audio 开关
    supportsNegative: true, supportsPromptExtend: true,
    tasks: [],
  },
  // 可灵 V3:std/pro 双模式,支持有声视频。modelId 带 'kling/' 前缀。
  // mode→res 映射:std→720P、pro→1080P(R3,buildVideoT2VJob 翻译成 resSnapshot)。
  'kling-v3-t2v': {
    key: 'kling-v3-t2v', label: '可灵 V3', modelId: 'kling/kling-v3-video-generation',
    shape: 'V_KLING',
    resolutions: ['720P', '1080P'], // 经 mode 映射:std→720P、pro→1080P
    ratios: ['16:9', '9:16', '1:1'],
    durationRange: [3, 15], defaultDuration: 5,
    maxPromptChars: 2500,
    priceTier: 6,
    supportsAudio: true, // 可灵 audio 布尔本轮生效(design D4)
    supportsNegative: false, supportsPromptExtend: false,
    tasks: [],
  },

  // ── 图转影片(i2v / r2v),本轮 4 模型全 V_DASH(可灵 i2v 降范围,media 体形未核实)──
  // 端点同 t2v(/video-generation/video-synthesis);input.media[{type,url}] 按 task 组。
  // HappyHorse i2v(首帧):无 ratio(跟首帧);prompt 可选。
  'happyhorse-1.0-i2v': {
    key: 'happyhorse-1.0-i2v', label: 'HappyHorse 1.0 (首帧)', modelId: 'happyhorse-1.0-i2v',
    shape: 'V_DASH',
    resolutions: ['720P', '1080P'],
    ratios: [], // i2v 首帧:比例跟首帧,不传 ratio
    durationRange: [3, 15], defaultDuration: 5,
    maxPromptChars: 2500,
    priceTier: 3,
    supportsAudio: false, supportsNegative: false, supportsPromptExtend: false,
    tasks: ['first_frame'], promptRequired: false,
  },
  // HappyHorse r2v(参考生):reference_image 1-9 张;prompt 必填(含 [图N] 指代);有 ratio。
  'happyhorse-1.0-r2v': {
    key: 'happyhorse-1.0-r2v', label: 'HappyHorse 1.0 (参考生)', modelId: 'happyhorse-1.0-r2v',
    shape: 'V_DASH',
    resolutions: ['720P', '1080P'],
    ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '4:5', '5:4', '9:21', '21:9'],
    durationRange: [3, 15], defaultDuration: 5,
    maxPromptChars: 2500,
    priceTier: 4,
    supportsAudio: false, supportsNegative: false, supportsPromptExtend: false,
    tasks: ['reference'], maxRefImages: 9, promptRequired: true,
  },
  // 万相2.7 i2v(首帧 / 首尾帧):比例跟首帧;prompt_extend + negative。
  'wan2.7-i2v': {
    key: 'wan2.7-i2v', label: '大师 (万相2.7 首帧/首尾帧)', modelId: 'wan2.7-i2v-2026-04-25',
    shape: 'V_DASH',
    resolutions: ['720P', '1080P'],
    ratios: [], // i2v 首帧/首尾帧:比例跟首帧
    durationRange: [2, 15], defaultDuration: 5,
    maxPromptChars: 5000,
    priceTier: 5,
    supportsAudio: false, supportsNegative: true, supportsPromptExtend: true,
    tasks: ['first_frame', 'first_last'], promptRequired: false,
  },
  // 万相2.7 r2v(参考生):reference_image ≤5 张(本轮不做 video/voice);prompt 必填;有 ratio。
  'wan2.7-r2v': {
    key: 'wan2.7-r2v', label: '大师 (万相2.7 参考生)', modelId: 'wan2.7-r2v',
    shape: 'V_DASH',
    resolutions: ['720P', '1080P'],
    ratios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    durationRange: [2, 15], defaultDuration: 5,
    maxPromptChars: 5000,
    priceTier: 6,
    supportsAudio: false, supportsNegative: true, supportsPromptExtend: true,
    tasks: ['reference'], maxRefImages: 5, promptRequired: true,
  },
};

// 默认模型(前端未传/老 job 兼容兜底)。大师(万相2.7)能力最全,作默认。
export const DEFAULT_VIDEO_MODEL = 'wan2.7-t2v';

/** 取模型定义;未知/缺省 → 默认模型。 */
export function getVideoModel(key?: string): VideoModelDef {
  if (key && isKnownVideoModel(key)) return VIDEO_MODELS[key]!;
  return VIDEO_MODELS[DEFAULT_VIDEO_MODEL]!;
}

/** 该 key 是否已知模型(buildVideoT2VJob 白名单校验用)。
 *  用 hasOwnProperty 防原型链污染('__proto__'/'constructor' 等不算已知模型)。 */
export function isKnownVideoModel(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(VIDEO_MODELS, key);
}

/** 用户端可选模型清单(前端下拉单一真相源)。 */
export function listVideoModels(): VideoModelDef[] {
  return Object.values(VIDEO_MODELS);
}

/** 可灵 mode → 分辨率档(R3:计价键统一按 res 字面量,可灵 std→720P、pro→1080P)。 */
export function klingModeToResolution(mode?: string): '720P' | '1080P' {
  return mode === 'pro' ? '1080P' : '720P';
}

// ── 图转影片(i2v)──
// 默认 i2v 模型(前端首选):wan2.7-i2v(首帧+首尾帧最全)。
export const DEFAULT_I2V_MODEL = 'wan2.7-i2v';

/** i2v/r2v 模型清单(tasks 非空 = 图转影片;前端 img2video 下拉真相源)。 */
export function listI2VModels(): VideoModelDef[] {
  return Object.values(VIDEO_MODELS).filter((d) => d.tasks.length > 0);
}

/** 取 i2v 模型(图转影片);未知/缺省 → 默认 i2v 模型(不回落到 t2v 模型)。 */
export function getI2VModel(key?: string): VideoModelDef {
  if (key && isKnownVideoModel(key) && VIDEO_MODELS[key]!.tasks.length > 0) return VIDEO_MODELS[key]!;
  return VIDEO_MODELS[DEFAULT_I2V_MODEL]!;
}
