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
// media 任务:first_frame=首帧、first_last=首尾帧、reference=参考生(图转影片);
// edit=视频编辑(影片编辑器,media 必含 1 个 video)。t2v(文生视频)模型 tasks 为空。
export type VideoTask = 'first_frame' | 'first_last' | 'reference' | 'edit';

export interface VideoModelDef {
  key: string; // 内部 key(input.model 存它)
  label: string; // UI 标签
  modelId: string; // 厂商实际 model 名(可灵带 'kling/' 前缀;豆包如 doubao-seedance-2.0)
  provider?: string; // 接入厂商(model-access-platform PR-2a);缺省 'bailian'。豆包='volc-ark'。
  shape: VideoShape;
  resolutions: ('720P' | '1080P')[]; // 支持的分辨率档(可灵经 mode 映射:std→720P、pro→1080P)
  ratios: string[]; // 支持的宽高比(i2v 首帧/首尾帧跟首帧自动 → 空数组)
  durationRange: [number, number]; // [最短, 最长] 秒
  defaultDuration: number; // 默认时长
  maxPromptChars: number; // 提示词字数上限(逐模型,reserve 前校验)
  // 每秒售价积分(= ceil(真实元/秒 × 35))。priceTier = 720P 基准;1080P/有声单列(真实比值随模型变)。
  // deriveVideoT2VParams 按 resolution(+可灵 audio)选好后快照;estimateVideoCost 的 resFactor=1(价已编码完)。
  priceTier: number; // 720P 无声 每秒售价积分
  priceTier1080?: number; // 1080P 每秒售价积分(缺省回落 priceTier)
  priceTierAudio?: number; // 可灵有声 720P 每秒售价积分(缺省回落 priceTier)
  priceTierAudio1080?: number; // 可灵有声 1080P 每秒售价积分(缺省回落 priceTier1080)
  supportsAudio: boolean; // 支持有声视频(audio 布尔;本轮仅可灵开关可见,见 design D4/R6)
  supportsNegative: boolean; // 支持反向提示词(仅 wan2.7)
  supportsPromptExtend: boolean; // 支持 prompt 智能改写(仅 wan2.7)
  // ── 图转影片(i2v)/ 视频编辑(edit)──
  tasks: VideoTask[]; // 支持的 media 任务(t2v 模型为 []);前端按此显隐 tab
  maxRefImages?: number; // 参考图上限(r2v:HH 9 / wan 5;edit:HH 5 / wan 4)
  promptRequired?: boolean; // prompt 必填(参考生/HH 编辑 true;首帧/首尾帧/wan 编辑可选)
  // ── 视频编辑(edit task)专属:输入视频约束 + 输出规则 ──
  videoDurRange?: [number, number]; // 输入视频时长界(秒;HH 3-60、wan 2-10)
  videoMaxMB?: number; // 输入视频大小上限(两家都 100MB)
  maxOutSeconds?: number; // 输出时长上限(HH=15:输入>15s 截前 15;wan 无上限=跟输入/截断)
  supportsTruncate?: boolean; // 支持 duration 截断参数(仅 wan 编辑,2-10s)
  supportsAudioOrigin?: boolean; // 支持 audio_setting=origin(保留原声;两编辑模型都支持)
  // ── 参考生影片多模态(video_r2v;仅 Seedance 2.0)──
  // 能力门控(eng-review P1#2):只有声明这两个上限的模型才接受 video/audio 参考。
  // 缺省 undefined = 不支持(wan/HH r2v 不声明 → video/audio refs 被拒,不泄漏)。
  maxVideoRefs?: number; // 参考视频上限(Seedance 3)
  maxAudioRefs?: number; // 参考音频上限(Seedance 3)
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
    priceTier: 32, priceTier1080: 56, // 真实 720P 0.9 / 1080P 1.6 元/秒 × 35
    supportsAudio: false, supportsNegative: false, supportsPromptExtend: false,
    tasks: [], // t2v:无 media 任务
  },
  // 万相2.7:大师模型,支持音频生成/反向提示词/prompt 智能改写。res 720P/1080P。
  // 注:audio 本轮靠 audio_url 上传(已缓,前端不暴露)→ supportsAudio 标 false,无可见开关(R6)。
  'wan2.7-t2v': {
    key: 'wan2.7-t2v', label: '大师 (万相2.7)', modelId: 'wan2.7-t2v-2026-04-25',
    shape: 'V_DASH',
    resolutions: ['720P', '1080P'],
    ratios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    durationRange: [2, 15], defaultDuration: 5,
    maxPromptChars: 5000,
    priceTier: 21, priceTier1080: 35, // 真实 720P 0.6 / 1080P 1.0 元/秒 × 35
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
    // 可灵真实(元/秒×35):无声 720P 0.6→21 / 1080P 0.8→28;有声 720P 0.9→32 / 1080P 1.2→42。
    priceTier: 21, priceTier1080: 28, priceTierAudio: 32, priceTierAudio1080: 42,
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
    priceTier: 32, priceTier1080: 56, // HH 首帧:720P 0.9 / 1080P 1.6 × 35
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
    priceTier: 32, priceTier1080: 56, // HH 参考生:720P 0.9 / 1080P 1.6 × 35
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
    priceTier: 21, priceTier1080: 35, // 万相2.7 首帧/首尾帧:720P 0.6 / 1080P 1.0 × 35
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
    priceTier: 21, priceTier1080: 35, // 万相2.7 参考生:720P 0.6 / 1080P 1.0 × 35(按输入+输出秒计)
    supportsAudio: false, supportsNegative: true, supportsPromptExtend: true,
    tasks: ['reference'], maxRefImages: 5, promptRequired: true,
  },

  // ── 视频编辑(edit task),两模型同端点同 media[],必含 1 个 video 元素 ──
  // 计费秒 = 输入时长 + 预计输出时长(贴厂商 usage.duration=in+out;eng-review 3A:tier 对齐同庐 r2v 档)。
  // ⚠ HappyHorse 编辑的 watermark 厂商默认 true(烙「Happy Horse」)→ 网关对 edit 模型显式传 false。
  'happyhorse-1.0-video-edit': {
    key: 'happyhorse-1.0-video-edit', label: 'HappyHorse 1.0 (视频编辑)', modelId: 'happyhorse-1.0-video-edit',
    shape: 'V_DASH',
    resolutions: ['720P', '1080P'],
    ratios: [], // 编辑:输出比例跟输入视频,无 ratio 参数
    durationRange: [3, 60], defaultDuration: 5, // 编辑模型 durationRange 即输入视频时长界
    maxPromptChars: 2500, // 「5000非中/2500中」取安全下限(同 HH t2v 口径)
    priceTier: 32, priceTier1080: 56, // HH 视频编辑:720P 0.9 / 1080P 1.6 × 35(按输入+输出秒计)
    supportsAudio: false, supportsNegative: false, supportsPromptExtend: false,
    tasks: ['edit'], maxRefImages: 5, promptRequired: true,
    videoDurRange: [3, 60], videoMaxMB: 100, maxOutSeconds: 15, // 输入>15s → 输出截前 15
    supportsTruncate: false, supportsAudioOrigin: true,
  },
  // 万相2.7 视频编辑:指令编辑/局部替换/风格迁移;ratio 可选(不传跟原视频)、duration 截断 2-10s。
  'wan2.7-videoedit': {
    key: 'wan2.7-videoedit', label: '大师 (万相2.7 视频编辑)', modelId: 'wan2.7-videoedit',
    shape: 'V_DASH',
    resolutions: ['720P', '1080P'],
    ratios: ['16:9', '9:16', '1:1', '4:3', '3:4'], // 可选:不传则跟原视频(前端首格「跟原视频」)
    durationRange: [2, 10], defaultDuration: 5,
    maxPromptChars: 5000,
    priceTier: 21, priceTier1080: 35, // 万相2.7 视频编辑:720P 0.6 / 1080P 1.0 × 35(按输入+输出秒计)
    supportsAudio: false, supportsNegative: true, supportsPromptExtend: true,
    tasks: ['edit'], maxRefImages: 4, promptRequired: false,
    videoDurRange: [2, 10], videoMaxMB: 100, // 输出=输入(或截断);无 15s 上限
    supportsTruncate: true, supportsAudioOrigin: true,
  },

  // ── 火山引擎 豆包 Seedance(PR-2a;provider='volc-ark',走 ark.ts 适配器)──
  // shape 复用 V_DASH 占位(ark 适配器自建请求体,不读 shape)。文本+图(首帧/首尾帧/参考生)+ 有声。
  // ⚠ 价格未录(火山按 token 计,非每秒固定价)→ priceTier 占位、cost_source 待用户在 admin 录真实成本前不启用。
  'doubao-seedance-2.0': {
    key: 'doubao-seedance-2.0', label: '豆包 Seedance 2.0', modelId: 'doubao-seedance-2-0-260128', provider: 'volc-ark',
    shape: 'V_DASH',
    resolutions: ['720P', '1080P'],
    ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    durationRange: [4, 15], defaultDuration: 5,
    maxPromptChars: 500,
    // 火山价格示例(5秒720p)折每秒:720P 4.97/5≈1.0→⌈1.0×35⌉=35;1080P 12.39/5≈2.5→⌈2.5×35⌉=88(model_pricing 为准)。
    priceTier: 35, priceTier1080: 88,
    // 有声(generate_audio)价档(eng-review P1#1:reference task 开音频不能按无声计价 → 漏钱)。
    // token 计价无固定有声系数 → 暂取无声×1.2 占位,标注 admin 录真实成本前需校准。
    priceTierAudio: 42, priceTierAudio1080: 106,
    supportsAudio: true, // generate_audio
    supportsNegative: false, supportsPromptExtend: false,
    tasks: ['first_frame', 'first_last', 'reference'], maxRefImages: 9, promptRequired: false,
    maxVideoRefs: 3, maxAudioRefs: 3, // 多模态参考(video_r2v):0-3 视频 + 0-3 音频
  },
  'doubao-seedance-2.0-fast': {
    key: 'doubao-seedance-2.0-fast', label: '豆包 Seedance 2.0 Fast', modelId: 'doubao-seedance-2-0-fast-260128', provider: 'volc-ark',
    shape: 'V_DASH',
    resolutions: ['720P'], // Fast 不支持 1080P
    ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    durationRange: [4, 15], defaultDuration: 5,
    maxPromptChars: 500,
    priceTier: 28, // 4.0/5 秒=0.8→⌈0.8×35⌉=28
    priceTierAudio: 34, // 有声占位(28×1.2);admin 录真实成本前需校准
    supportsAudio: true,
    supportsNegative: false, supportsPromptExtend: false,
    tasks: ['first_frame', 'first_last', 'reference'], maxRefImages: 9, promptRequired: false,
    maxVideoRefs: 3, maxAudioRefs: 3,
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
// ⚠ 三向隔离(eng-review A1):t2v=tasks 空、i2v=含 I2V_TASKS、edit=含 'edit'。
// 不能再用「tasks 非空」当 i2v 过滤条件,否则 edit 模型会泄进图转影片页。
const I2V_TASKS: VideoTask[] = ['first_frame', 'first_last', 'reference'];

// 默认 i2v 模型(前端首选):wan2.7-i2v(首帧+首尾帧最全)。
export const DEFAULT_I2V_MODEL = 'wan2.7-i2v';

/** i2v/r2v 模型清单(tasks 含图转任务;前端 img2video 下拉真相源)。不含 edit 模型。 */
export function listI2VModels(): VideoModelDef[] {
  return Object.values(VIDEO_MODELS).filter((d) => d.tasks.some((t) => I2V_TASKS.includes(t)));
}

/** 取 i2v 模型(图转影片);未知/缺省/非 i2v → 默认 i2v 模型(不回落 t2v / edit)。 */
export function getI2VModel(key?: string): VideoModelDef {
  if (key && isKnownVideoModel(key) && VIDEO_MODELS[key]!.tasks.some((t) => I2V_TASKS.includes(t))) {
    return VIDEO_MODELS[key]!;
  }
  return VIDEO_MODELS[DEFAULT_I2V_MODEL]!;
}

// ── 参考生影片多模态(r2v;仅 Seedance 2.0 声明 maxVideoRefs/maxAudioRefs)──
// 能力门控:r2v 模型 = 声明了 maxVideoRefs 的模型(只有它们接受 video/audio 参考)。
export const DEFAULT_R2V_MODEL = 'doubao-seedance-2.0';

/** 多模态参考生模型清单(声明 maxVideoRefs;前端 ref-video 下拉真相源)。 */
export function listR2VModels(): VideoModelDef[] {
  return Object.values(VIDEO_MODELS).filter((d) => typeof d.maxVideoRefs === 'number');
}

/** 取 r2v 模型(多模态参考生);未知/缺省/非 r2v → 默认 r2v 模型。 */
export function getR2VModel(key?: string): VideoModelDef {
  if (key && isKnownVideoModel(key) && typeof VIDEO_MODELS[key]!.maxVideoRefs === 'number') {
    return VIDEO_MODELS[key]!;
  }
  return VIDEO_MODELS[DEFAULT_R2V_MODEL]!;
}

// ── 视频编辑(edit)──
export const DEFAULT_EDIT_MODEL = 'wan2.7-videoedit';

/** 视频编辑模型清单(tasks 含 'edit';前端 video-edit 下拉真相源)。 */
export function listEditModels(): VideoModelDef[] {
  return Object.values(VIDEO_MODELS).filter((d) => d.tasks.includes('edit'));
}

/** 取视频编辑模型;未知/缺省/非 edit → 默认编辑模型(不回落 t2v / i2v)。 */
export function getEditModel(key?: string): VideoModelDef {
  if (key && isKnownVideoModel(key) && VIDEO_MODELS[key]!.tasks.includes('edit')) {
    return VIDEO_MODELS[key]!;
  }
  return VIDEO_MODELS[DEFAULT_EDIT_MODEL]!;
}
