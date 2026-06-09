// 灵镜 能力网关 — 接口契约。
//
// 这是护城河基建:业务只声明动词("生成数字人视频"),不绑厂商。
// 托管 = 平台百炼 key;私有化 = 客户云账号 key(切换点在 adapter 工厂)。
// 决策来源:/plan-eng-review 设计文档"能力网关接口契约" + D2(异步可切换)。

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
}

// ── 图生图(image-to-image,qwen-image-edit)──
// ⚠️ 同步模型:调用直接返回图数组,不轮询(与文生图/视频的异步 task 不同)。
// 故独立于异步 CapabilityGateway,放 SyncImageGateway(外部声音 P2:不污染异步契约)。
export interface ImageEditInput {
  model?: string; // 模型 key(registry,缺省 → 编辑默认)
  imageUrls: string[]; // 输入图公网 URL(1-3 张,worker 已 publish)
  prompt: string; // 编辑指令
  ratio?: string;
  resolution?: string;
  seed?: number; // 随机种子;空 = 随机
}

// ── 文转语音(TTS,cosyvoice)──
// synthesizeSpeech 已是独立函数(WebSocket→MP3 Buffer);worker tts 分支直接调,不加网关接口。
export interface TtsGenInput {
  text: string; // 待配音文本(超 cosyvoice 单次上限按句分段)
  voiceRef: string; // 音色:预置音色名 或 克隆音色 id(经 voices 校验)
  rate?: number; // 语速 0.5-2,默认 1
  volume?: number; // 音量 0-100,默认 50
}

export interface SyncImageGateway {
  /** 同步图生图(S 形状,含图 content)。直返成品图 URL 数组(百炼侧,24h 过期 → worker 须拉进存储)。
   *  传入 AbortSignal 做硬超时(外部声音 P2:同步调无 poll 循环检 deadline,挂连接会冻 worker)。 */
  editImage(input: ImageEditInput, signal: AbortSignal): Promise<string[]>;
  /** 同步文生图(S 形状,纯文本 content,无输入图)。同 multimodal 端点直返,AbortController 硬超时。
   *  eng 外部声音 P1-a:S 模型 text2img 需独立方法(editImage 必填 imageUrls)。 */
  generateImageSync(input: ImageGenInput, signal: AbortSignal): Promise<string[]>;
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

  /** 获取图片任务状态(成品在 results[] 或 choices[].message.content[].image,双解析)。 */
  fetchImageStatus(providerTaskId: string): Promise<ImageJobResult>;
}
