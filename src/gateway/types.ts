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

/**
 * 能力网关。业务只依赖这个接口,不 import 任何厂商 SDK。
 * Slice1 只实现 submitVideo + fetchJobStatus(命脉闭环够用)。
 * cloneVoice / synthesizeTTS / createAvatar 在 Slice3 自定义素材时补。
 */
export interface CapabilityGateway {
  /** 提交视频生成(wan2.2-s2v),传图 URL + 音频 URL,返回厂商侧 task_id(异步)。 */
  submitVideo(urls: VideoSubmitUrls): Promise<string>;

  /**
   * 获取厂商侧任务状态。
   * poll 模式:worker 周期调用此方法。
   * webhook 模式:厂商回调时由 webhook handler 调用此方法核对(私有化内网用 poll 兜底)。
   */
  fetchJobStatus(providerTaskId: string): Promise<ProviderJobResult>;
}
