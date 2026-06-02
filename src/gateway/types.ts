// 灵镜 能力网关 — 接口契约。
//
// 这是护城河基建:业务只声明动词("生成数字人视频"),不绑厂商。
// 托管 = 平台百炼 key;私有化 = 客户云账号 key(切换点在 adapter 工厂)。
// 决策来源:/plan-eng-review 设计文档"能力网关接口契约" + D2(异步可切换)。

export interface VideoGenInput {
  avatarRef: string; // 形象引用(Slice1 = 预置形象 ID)
  voiceRef: string; // 音色引用(Slice1 = 预置音色,如 cosyvoice-v1)
  script: string; // 文案 ≤2000 字
  resolution?: string; // 如 '1080P'
  ratio?: string; // 16:9 | 9:16 | 1:1
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
  /** 提交视频生成,返回厂商侧 task_id(异步)。 */
  submitVideo(input: VideoGenInput): Promise<string>;

  /**
   * 获取厂商侧任务状态。
   * poll 模式:worker 周期调用此方法。
   * webhook 模式:厂商回调时由 webhook handler 调用此方法核对(私有化内网用 poll 兜底)。
   */
  fetchJobStatus(providerTaskId: string): Promise<ProviderJobResult>;
}
