// 灵镜 能力网关 — 接口契约。
//
// 这是护城河基建:业务只声明动词("生成数字人视频"),不绑厂商。
// 托管 = 平台百炼 key;私有化 = 客户云账号 key(切换点在 adapter 工厂)。
// 决策来源:/plan-eng-review 设计文档"能力网关接口契约" + D2(异步可切换)。

import type { VideoTask } from './video-models.js';

// 业务侧入参(API/队列用):仍是"形象+音色+文案"。
export interface VideoGenInput {
  avatarRef: string; // 形象引用(预置 ID 或自定义形象 id)
  voiceRef: string; // 音色引用(预置音色名 或克隆音色 id)
  script: string; // 文案 ≤2000 字
  resolution?: string; // wan2.2-s2v 支持 480P | 720P
  ratio?: string; // 预留(s2v 由图片比例决定,暂不强制)
  speed?: number; // 配音语速 0.5-2(PRD E4),默认 1
  volume?: number; // 配音音量 0-100(PRD E4),默认 50
}

// 网关侧入参(已解析为公网 URL):wan2.2-s2v 真实需要的是图 + 音频 URL。
// 查证:阿里 wan2.2-s2v 不做 TTS,只做"音频驱动图片口型",故文案需先经 CosyVoice 转音频。
export interface VideoSubmitUrls {
  imageUrl: string; // 数字人脸图(公网可访问)
  audioUrl: string; // 驱动音频(公网可访问,由 TTS 产出后上传得到)
  resolution?: '480P' | '720P';
}

/** 厂商侧任务状态(网关把各厂商的状态归一到这 4 态)。 */
export type ProviderJobStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface ProviderJobResult {
  status: ProviderJobStatus;
  progress?: number; // 0-100,厂商若不给则 undefined
  videoUrl?: string; // succeeded 时的成品 URL
  aiLabel?: 'native' | 'none'; // 厂商成品是否自带 AI 标识(C-code 探明)
  error?: string;
}

// ── AI 图片(文生图,qwen-image)──
// 异步任务:submit 返 task_id,poll 直到 SUCCEEDED;成品在 output.results[].url(数组,多图)。
export interface ImageGenInput {
  model?: string; // 模型 key(registry,缺省 → DEFAULT_IMAGE_MODEL,兼容老 job 无此字段)
  mode?: 'text2img' | 'img2img'; // 子模式;缺省=text2img(兼容老 job)
  source?: 'ai-image' | 'ai-image-edit'; // 来源页(记录归属;前端发起页,与 mode 无关)
  prompt: string; // 提示词(文生图描述 / 图生图编辑指令)
  count?: number; // 出图张数(worker 已按 model maxImages clamp);img2img 固定 1
  resolution?: string; // 1K | 2K | 4K(按 model sizeKind 映射)
  ratio?: string; // 比例:auto | 16:9 | 9:16 | 1:1 | 3:4 | 4:3 | 3:2 | 2:3(与 resolution 共同决定 size)
  imageRefs?: string[]; // img2img:已上传输入图的存储 key(1-3 张;万相2.7 编辑 0-5 张);worker 经 publish 转公网 URL
  bboxList?: number[][][]; // 局部重绘框选(仅万相2.7 A_EDIT):外=每张输入图,中=≤2 框,内=[x1,y1,x2,y2] 原图像素;空框图传 []
  seed?: number; // 随机种子 [0,2147483647];空/未传 = 随机(gateway 不加该字段)
  priceTierSnapshot?: number; // 提交时快照(P3:admin 改价 mid-flight 不破 reserve==settle)
  maxImagesSnapshot?: number; // 同上,张数上限快照
  width?: number; // 提交时从所选分辨率条快照的 W(P1-c:admin 改 resolutions mid-flight 不影响在飞 job)
  height?: number;
  // ── gpt-image-2(token 计价模型,Design B 真实用量结算)──
  quality?: string; // 画质 low|medium|high(仅 qualities 模型;OpenAI quality 参数 + 计价上界估算轴)
  priceRateSnapshot?: number; // 提交快照:每 output token 的真实成本元(reserve/settle 同源)
  usageSnapshot?: ImageUsage; // worker 回写的实际 usage(costFor 读它按实结算,同音乐 durationSnapshot)
}

// gpt-image-2 等 token 计价模型的用量(网关从响应 usage 解析,worker 回写 input.usageSnapshot 供结算)。
// 三类 token 费率不同($/1M):output 图 $30、input 图 $8(编辑输入底图)、input 文本 $5。
// 精算需按类分别计价 → 拆出 input 明细(usage.input_tokens_details);缺失时按 mode 兜底(见 credits.costFor)。
export interface ImageUsage {
  inputTokens: number; // 输入 token 合计(文本 + 图)
  outputTokens: number; // 输出图 token(计价主轴,$30/1M)
  totalTokens: number; // 合计
  inputImageTokens?: number; // 输入图 token($8/1M;编辑输入底图,高保真处理)
  inputTextTokens?: number; // 输入文本 token($5/1M;prompt)
}

// ── 图生图(image-to-image,qwen-image-edit)──
// ⚠️ 同步模型:调用直接返回图数组,不轮询(与文生图/视频的异步 task 不同)。
// 故独立于异步 CapabilityGateway,放 SyncImageGateway(外部声音 P2:不污染异步契约)。
export interface ImageEditInput {
  model?: string; // 模型 key(registry,缺省 → 编辑默认)
  imageUrls: string[]; // 输入图公网 URL(1-3 张,worker 已 publish)
  prompt: string; // 编辑指令
  count?: number; // 出图张数(同步编辑模型按 maxImages clamp;qwen-image-edit=1);editImage 传 n
  ratio?: string;
  resolution?: string;
  seed?: number; // 随机种子;空 = 随机
  quality?: string; // 画质 low|medium|high(token 计价模型 gpt-image-2 编辑用;OpenAI quality 参数 + 计价轴)
  priceRateSnapshot?: number; // 提交快照:每 output token 成本元(token 计价编辑,reserve==settle)
}

// ── 文生视频(text2video:HappyHorse / 万相2.7 / 可灵)──
// 异步任务:submitVideoT2V 返 task_id,轮询 /tasks/{id} 直到 SUCCEEDED;成品在 output.video_url。
// 与数字人 s2v(图+音频驱动口型)是不同形状 —— 纯文生视频,无 TTS、无图、无分段。
// i2v(图转影片)复用此 input,多 task + imageRefs 维度。
export interface VideoGenT2VInput {
  model?: string; // 模型 key(registry,缺省 → DEFAULT_VIDEO_MODEL)
  prompt?: string; // 文本提示词(t2v/参考生必填;i2v 首帧/首尾帧可选 → 逐模型 maxPromptChars 校验)
  resolution?: string; // 720P | 1080P(V_DASH 直传;V_KLING 由 mode 映射,不直传)
  ratio?: string; // 宽高比(16:9 / 9:16 / 1:1 ...)
  duration?: number; // 时长(秒,clamp 到 model durationRange)
  mode?: 'std' | 'pro'; // 仅 V_KLING:生成模式(std=720P、pro=1080P)
  audio?: boolean; // 仅 V_KLING:有声视频(计价加价;V_DASH 恒 false,R6)
  negativePrompt?: string; // 仅 wan2.7:反向提示词
  promptExtend?: boolean; // 仅 wan2.7:prompt 智能改写
  seed?: number; // 随机种子 [0,2147483647];空 = 随机
  // ── 图转影片(i2v / video_i2v;t2v 不用)──
  task?: VideoTask; // media 任务:first_frame / first_last / reference / edit
  imageRefs?: string[]; // 输入图存储 key(worker publish 转公网 URL 后就地覆写;submit 按 task 组 media)
  // ── 参考生影片多模态(video_r2v;Seedance 2.0 多模态参考)──
  // 三类 typed 数组,worker 各自 publish 转公网 URL 后就地覆写;绝不 merge 进 imageRefs(否则 wan/HH 收到 video URL 当 reference_image → 400)。
  videoRefs?: string[]; // 参考视频存储 key(0-3;role=reference_video)
  audioRefs?: string[]; // 参考音频存储 key(0-3;role=reference_audio)
  // ── 视频编辑(video_edit;task='edit')──
  videoRef?: string; // 输入视频存储 key(worker publish 转公网 URL 后就地覆写;media 首元素 {type:'video'})
  audioSetting?: 'auto' | 'origin'; // 声音:auto=模型自控(缺省不发)、origin=保留原声
  truncateDuration?: number; // 仅 wan 编辑:截断输出时长(2-10s);缺省=跟输入,不发 duration
  // ── 提交时快照(钱路 reserve==settle:admin/前端 mid-flight 改不破)──
  durationSnapshot?: number; // clamp 后的时长
  resSnapshot?: string; // 计价用分辨率档(可灵由 mode 翻译写入,R3)
  audioSnapshot?: boolean; // 计价用 audio(V_DASH 恒 false)
  priceTierSnapshot?: number; // 提交时模型每秒计价基数
  inputDurationSnapshot?: number; // 编辑:服务端探测的输入视频时长(秒,sidecar 真相)
  billableSecondsSnapshot?: number; // 编辑:计费秒快照 = 输入 + 预计输出(贴厂商 in+out)
}

// ── 文转语音(TTS,全 Qwen-TTS HTTP)──
// synthesizeSpeechHttp 独立函数(MultiModalConversation→MP3 Buffer);worker tts 分支直接调。
// 无「品质」模型选择:系统按是否带情绪自动选 flash/instruct(见 worker.resolveVoice)。
export interface TtsGenInput {
  text: string; // 待配音文本(超 Qwen 单次上限按句分段)
  voiceRef: string; // 音色:系统音色名 或 复刻/设计 voice id(经 voices 校验)
  emotion?: string; // 情绪 key(EMOTIONS);worker 转 instructions(系统音色经 instruct 模型落地)。
  rate?: string; // 语速档位 key(SPEEDS;非倍速);折进 instructions(同上)。'normal'/缺省=不加。
  pitch?: number; // 音高 -12~+12;折进 instructions(同上,仅系统音色 instruct 落地)。
  language?: string; // 语言 key(LANGUAGES;= API language_type)。'Auto'/缺省=不下发(模型自判)。
  pricePerCharSnapshot?: number; // 遗留:旧 job 可能带快照单价;credits.costFor 读它保 reserve==settle。
}

// ── AI 音乐(Fun-Music HTTP)──
// generateMusic 独立函数(同步→audio.url + lyrics + duration);worker ai_music 分支直接调。
// 模式:song(歌曲,有歌词/人声性别) | instrumental(纯音乐,仅 prompt)。
export interface AiMusicGenInput {
  mode: 'song' | 'instrumental';
  prompt?: string; // 提示词(风格/场景);与 lyrics 二选一
  lyrics?: string; // 歌词(仅 song);与 prompt 二选一,同传仅 lyrics 生效
  gender?: 'male' | 'female'; // 人声性别(仅 song)
  model?: string; // fun-music-preview / fun-music-v1
  durationSnapshot?: number; // worker 写回的实际 usage.duration(秒);costFor 按它结算(封顶 reserved)。
  lyricsResult?: string; // worker 写回的 extra_info.lyrics(前端记录卡展示)。
}

export interface SyncImageGateway {
  /** 同步图生图(S 形状,含图 content)。直返成品图 URL 数组(百炼侧,24h 过期 → worker 须拉进存储)。
   *  传入 AbortSignal 做硬超时(外部声音 P2:同步调无 poll 循环检 deadline,挂连接会冻 worker)。 */
  editImage(input: ImageEditInput, signal: AbortSignal): Promise<SyncImageResult>;
  /** 同步文生图(S 形状,纯文本 content,无输入图)。同 multimodal 端点直返,AbortController 硬超时。
   *  eng 外部声音 P1-a:S 模型 text2img 需独立方法(editImage 必填 imageUrls)。
   *  返回 { urls, usage? }:token 计价模型(gpt-image-2)带 usage 供实结算;其余 provider usage 置 undefined。 */
  generateImageSync(input: ImageGenInput, signal: AbortSignal): Promise<SyncImageResult>;
}

/** generateImageSync 结果:成品 URL 数组 + 可选 usage(仅 token 计价模型如 gpt-image-2)。 */
export interface SyncImageResult {
  urls: string[];
  usage?: ImageUsage;
}

export interface ImageJobResult {
  status: ProviderJobStatus;
  progress?: number;
  imageUrls?: string[]; // succeeded 时的多图 URL 数组(百炼侧,24h 过期 → worker 须拉进存储)
  error?: string;
}

/**
 * 能力网关。业务只依赖这个接口,不 import 任何厂商 SDK。
 * 视频(数字人):submitVideo + fetchJobStatus(命脉闭环)。
 * 图片(AI 图片):submitImage + fetchImageStatus(多工具平台第一个新工具)。
 * 注:图片成品是 results[] 数组、端点不同,故 fetchImageStatus 独立于 fetchJobStatus(eng-review/外部声音 P2)。
 * cloneVoice / synthesizeTTS 在后续工具补。
 */
export interface CapabilityGateway {
  /** 提交视频生成(wan2.2-s2v),传图 URL + 音频 URL,返回厂商侧 task_id(异步)。 */
  submitVideo(urls: VideoSubmitUrls): Promise<string>;

  /**
   * 获取视频任务状态。
   * poll 模式:worker 周期调用此方法。
   * webhook 模式:厂商回调时由 webhook handler 调用此方法核对(私有化内网用 poll 兜底)。
   */
  fetchJobStatus(providerTaskId: string): Promise<ProviderJobResult>;

  /** 提交文生图(qwen-image),返回厂商侧 task_id(异步)。 */
  submitImage(input: ImageGenInput): Promise<string>;

  /** 提交万相2.7 含图编辑(A_EDIT,异步多模态体 + bbox_list),返回厂商侧 task_id。 */
  submitImageEdit(input: ImageGenInput): Promise<string>;

  /** 提交文生视频(HappyHorse/万相2.7/可灵,异步),按 shape 组体,返回厂商侧 task_id。
   *  成品轮询走 fetchJobStatus(三家与 s2v 同 /tasks/{id} + output.video_url 顶层字段)。 */
  submitVideoT2V(input: VideoGenT2VInput): Promise<string>;

  /** 获取图片任务状态(成品在 results[] 或 choices[].message.content[].image,双解析)。 */
  fetchImageStatus(providerTaskId: string): Promise<ImageJobResult>;
}
