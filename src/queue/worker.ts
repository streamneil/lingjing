// 灵镜 worker — 拉任务、跑生成管线、写回状态。
//
// 失败隔离(/plan-eng-review D7,护城河卵论点):每个 job 的处理包在 try/catch 里,
// 单个 job 抛错只把自己标 failed,绝不冒泡到轮询循环 → 一个坏任务不影响其它任务、
// 不拖垮 worker、不影响平台可用性。失败隔离 E2E 专门验证这一点。
//
// 管线:moderate(文案) → 网关提交 → 轮询直到完成/超时 → moderate(成品) → 落 MinIO → markDone

import { config } from '../config.js';
import { getGateway } from '../gateway/baichuan.js';
import { synthesizeSpeechHttp } from '../gateway/cosyvoice.js';
import { generateMusic } from '../gateway/fun-music.js';
import { buildInstruction } from '../gateway/tts-models.js';
import { getMediaPublisher, tenantDelivery } from '../gateway/media-publisher.js';
import type { VideoGenInput, VideoSubmitUrls, ImageGenInput, TtsGenInput, VideoGenT2VInput, ProviderJobStatus, AiMusicGenInput } from '../gateway/types.js';
import { storage } from '../storage/index.js';
import { listPresets as listAvatarPresets, getAvatar } from '../avatars/index.js';
import { isPreset as isPresetVoice, getVoice } from '../voices/index.js';
import { moderateScript, moderatePrompt, moderateImageInput, moderateOutput } from '../pipeline/moderation.js';
import { applyAiLabel, probeAudioDuration, concatVideos } from '../pipeline/ai-label.js';
import { segmentScript } from '../pipeline/segment.js';
import { concatAudio } from '../pipeline/concat-audio.js';
import { getImageModel } from '../gateway/image-models.js';
import { settle, release, estimateCost, costFor, reservedFor } from '../credits/index.js';
import { db } from '../db/index.js';

/** 读租户的 AI 标识设置(默认开启 + "AI 合成")。 */
function getAiLabelConfig(tenantId: string): { enabled: boolean; text: string } {
  const get = (key: string, def: string) => {
    const row = db
      .prepare(`SELECT value FROM tenant_setting WHERE tenant_id=? AND key=?`)
      .get(tenantId, key) as { value: string } | undefined;
    return row?.value ?? def;
  };
  return {
    enabled: get('ai_label_enabled', 'true') === 'true',
    text: get('ai_label_text', 'AI 合成'),
  };
}
import {
  claimNextJob,
  setProviderTaskId,
  updateProgress,
  markDone,
  markFailed,
  type JobRow,
} from './index.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 关机中断哨兵:pollUntilDone 在收到停止信号时抛它。
 *  捕获方据此「不标 failed、不退预扣」—— job 留 running,交启动重调归位(eng-review Finding 1)。 */
export class WorkerStoppingError extends Error {
  constructor() {
    super('worker 关机中,任务留待重启重调');
    this.name = 'WorkerStoppingError';
  }
}

/** 提交或续跑(2026-06-16 并发改造,单任务异步 runner 共用)。
 *  崩溃重启后 recoverStuckJobs 把在飞 job 重入队,重跑时 job 已带 baichuan_task_id →
 *  跳过 submit、直接续跑现有厂商任务,避免双提交双扣费(eng-review Finding 2)。
 *  注:仅适用「一个 job 一个厂商任务」的 runner;分段 s2v 一 job 多任务,不走此路(重入队从头跑)。 */
async function submitOrResume(job: JobRow, submit: () => Promise<string>): Promise<string> {
  if (job.baichuan_task_id) return job.baichuan_task_id;
  const taskId = await submit();
  setProviderTaskId(job.id, taskId);
  return taskId;
}

/** 厂商任务轮询循环关心的最小字段(各 fetch 返回的具体类型须结构兼容它)。 */
interface PollShape {
  status: ProviderJobStatus;
  progress?: number;
  error?: string;
}

/**
 * 通用异步任务轮询(eng-review CQ1:唯一一份循环,renderSegment / runImageGenJob /
 * runVideoT2VJob 三处共用,消除 3 份拷贝)。泛型 T 让调用方拿回完整结果取自己的字段
 * (s2v 取 videoUrl、图片取 imageUrls、t2v 取 videoUrl)。
 *
 *   ┌─ 轮询循环 ─────────────────────────────────────────────┐
 *   │  超 deadline → 抛超时(sawRunning 区分「排队/生成」文案)   │
 *   │  fetchFn() → status                                     │
 *   │    running  → sawRunning=true; onProgress(progress??50)  │
 *   │    其它     → onProgress(progress??5)                    │
 *   │    succeeded→ return result(调用方取自己的字段)          │
 *   │    failed   → 抛 error                                   │
 *   │  sleep(pollIntervalMs) → 下一轮                          │
 *   └─────────────────────────────────────────────────────────┘
 *
 * @param fetchFn 拉一次厂商状态;@param onProgress 进度回调(0-100);
 * @param deadline 整 job 共享的超时上限(epoch ms,调用方按工具类型传不同上限)。
 */
export async function pollUntilDone<T extends PollShape>(
  fetchFn: () => Promise<T>,
  onProgress: (pct: number) => void,
  deadline: number,
): Promise<T> {
  let sawRunning = false;
  for (;;) {
    // 优雅关机:收到停止信号则提前跳出,job 留 running,交启动重调归位(eng-review Finding 1)。
    //   不标 failed、不退预扣 —— 厂商任务可能仍在跑,重启后按 task_id 重调才知道真实结果。
    if (stopped) throw new WorkerStoppingError();
    if (Date.now() > deadline) {
      throw new Error(
        sawRunning
          ? '生成超时,已放弃'
          : '排队超时:生成服务繁忙(免费档同时只跑 1 个任务),请稍后重试或减少并发',
      );
    }
    const r = await fetchFn();
    if (r.status === 'running') sawRunning = true;
    if (typeof r.progress === 'number') onProgress(r.progress);
    else onProgress(r.status === 'running' ? 50 : 5);
    if (r.status === 'succeeded') return r;
    if (r.status === 'failed') throw new Error(r.error ?? '厂商任务失败');
    await sleep(config.baichuan.pollIntervalMs);
  }
}

/** 把 avatarRef 解析为公网可访问的脸图 URL(预置=外链;自定义=经发布策略转公网 URL)。 */
async function resolveImageUrl(avatarRef: string, tenantId: string): Promise<string> {
  const preset = listAvatarPresets().find((p) => p.id === avatarRef);
  // 预置源帧改走与自定义形象同一发布策略(去中心化:不再依赖公共桶外链)。thumbKey 在运营自己桶,
  // publish() 按交付模式转成百炼可拉 URL(托管=签名直链;私有化=中转,见 media-publisher)。
  if (preset) return getMediaPublisher(tenantDelivery(tenantId)).publish(preset.thumbKey);
  // worker 无 acting user(异步处理);提交时已做账号校验(isUsableAvatar),此处按租户解析(isAdmin=true)即可。
  const custom = getAvatar(avatarRef, tenantId, '', true);
  if (custom?.source_key) {
    // 自定义素材经发布策略(托管=签名URL;私有化=中转),保证百炼可访问
    return getMediaPublisher(tenantDelivery(tenantId)).publish(custom.source_key);
  }
  throw new Error(`形象不可用:${avatarRef}`);
}

/** 把 voiceRef 解析为 {voice, model}。全 Qwen-TTS,走 HTTP(零 CosyVoice)。
 *  合成模型由系统按音色类型 + 是否带情绪定(用户不选模型):
 *   - 预置(系统音色)→ 有情绪用 qwenInstructModel(指令模型),否则 qwenTtsModel(flash)。
 *   - 克隆(VC)→ vcModel(创建与合成必须同 target_model);情绪指令仅系统音色支持,故忽略。
 *   - 设计(VD)→ designModel;同上忽略情绪。
 *  复刻/设计未产出(provider_voice_id 空)则回退预置,避免任务整体失败。
 *  withEmotion:本次是否带情绪/音高(仅影响预置选 instruct vs flash)。 */
export function resolveVoice(
  voiceRef: string,
  tenantId: string,
  withEmotion = false,
): { voice: string; model: string; isSystem: boolean } {
  const presetModel = withEmotion ? config.baichuan.qwenInstructModel : config.baichuan.qwenTtsModel;
  // isSystem:系统(预置)音色才支持 instructions(情绪/语速/音高)与 language_type;
  // 复刻(VC)/设计(VD)音色均不支持(阿里官方),给它们下发会 400(TTS speak request failed)。
  if (isPresetVoice(voiceRef)) return { voice: voiceRef, model: presetModel, isSystem: true };
  // worker 无 acting user;提交时已账号校验,此处按租户解析(isAdmin=true)。
  const v = getVoice(voiceRef, tenantId, '', true);
  if (v?.provider_voice_id) {
    if (v.kind === 'design') return { voice: v.provider_voice_id, model: config.baichuan.designModel, isSystem: false };
    // 克隆(VC):voice + 同 target_model 合成
    return { voice: v.provider_voice_id, model: config.baichuan.vcModel, isSystem: false };
  }
  // 克隆/设计未产出 / 解析失败:回退预置音色(Qwen,系统音色),避免任务整体失败
  return { voice: DEFAULT_PRESET_VOICE, model: presetModel, isSystem: true };
}

// 默认回退音色:Qwen-TTS 合法音色名(专业播音场景)
const DEFAULT_PRESET_VOICE = 'Neil';

// 按 magic number 判音频真实格式(wan2.2-s2v 只认 .wav/.mp3,扩展名须与字节一致)。
// WAV: 'RIFF'....'WAVE';MP3: 'ID3' 标签 或 帧同步 0xFFEx/0xFFFx。识别不出回退 mp3。
export function detectAudioFormat(buf: Buffer): 'wav' | 'mp3' {
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') return 'wav';
  if (buf.length >= 3 && buf.toString('ascii', 0, 3) === 'ID3') return 'mp3';
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0) return 'mp3';
  return 'mp3';
}

/**
 * 渲染单个文案片段(<20s):文案 → TTS → 落 MinIO → s2v 提交 → 轮询 → 抓成品 Buffer。
 * 不打水印、不落最终库(那是整条视频拼好后做一次)。抛错冒泡给 processJob 标 failed。
 *
 * @param onProgress 进度回调(0-100,已按段映射);@param deadline 整 job 共享的超时上限。
 */
async function renderSegment(
  job: JobRow,
  segIndex: number,
  segScript: string,
  imageUrl: string,
  voice: string,
  ttsModel: string,
  input: VideoGenInput,
  deadline: number,
  onProgress: (pct: number) => void,
): Promise<Buffer> {
  // 1. 文案 → Qwen-TTS(HTTP)→ 音频(全 Qwen,零 CosyVoice;Qwen 无 rate/volume)
  const audioBuf = await synthesizeSpeechHttp({ text: segScript, voice, model: ttsModel });
  // wan2.2-s2v 硬约束:音频 <20s 且 <15M。分段后单段应已 <20s;仍兜底校验,超了说明该段切分不当。
  if (audioBuf.length > 15 * 1024 * 1024) {
    throw new Error(`第 ${segIndex + 1} 段音频超过 15MB(wan2.2-s2v 上限)`);
  }
  const dur = await probeAudioDuration(audioBuf);
  if (dur !== null && dur >= 20) {
    throw new Error(`第 ${segIndex + 1} 段音频 ${dur.toFixed(1)}s 仍超 20s,请缩短该段或降低语速`);
  }
  // 按真实字节判格式(qwen3-tts 经 multimodal-generation 默认回 WAV,非 MP3)。
  // wan2.2-s2v 只认 .wav/.mp3,且按内容/扩展名校验——若把 WAV 当 .mp3 上传会报
  // "File type is not supported. Allowed types are: .wav, .mp3."。故扩展名/Content-Type 必须与字节一致。
  const fmt = detectAudioFormat(audioBuf); // 'wav' | 'mp3'
  const audioKey = `tts/${job.tenant_id}/${job.id}-seg${segIndex}.${fmt}`;
  await storage.putObject(audioKey, audioBuf, fmt === 'wav' ? 'audio/wav' : 'audio/mpeg');
  const audioUrl = await getMediaPublisher(tenantDelivery(job.tenant_id)).publish(audioKey);

  // 2. 网关提交(wan2.2-s2v:image_url + audio_url)
  const submitRes: '480P' | '720P' = input.resolution === '480P' ? '480P' : '720P';
  const urls: VideoSubmitUrls = { imageUrl, audioUrl, resolution: submitRes };
  const gateway = getGateway(); // s2v 数字人固定百炼 wan2.2-s2v(无 model 字段)
  const providerTaskId = await gateway.submitVideo(urls);
  setProviderTaskId(job.id, providerTaskId);

  // 3. 轮询直到完成 / 失败 / 超时(超时上限为整 job 共享,防永久 running)。
  //    eng-review CQ1:走共享 pollUntilDone(段内进度由 onProgress 映射到整 job 的该段区间)。
  const done = await pollUntilDone(() => gateway.fetchJobStatus(providerTaskId), onProgress, deadline);
  const videoUrl = done.videoUrl;
  if (!videoUrl) throw new Error('厂商成功但未返回成品 URL');

  // 4. 段成品抓为 Buffer(拼接前不落最终库)
  const resp = await fetch(videoUrl);
  if (!resp.ok) throw new Error(`抓取第 ${segIndex + 1} 段成品失败 ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

/** 处理一个数字人(AI 虚拟人)视频 job 的完整管线。抛错由调用方捕获并标 failed(失败隔离)。
 *
 * 长文案分段:wan2.2-s2v 单次驱动音频硬限 <20s(百炼官方)。超 20s 的文案按句切成
 * 多段(segment.ts),逐段 TTS→s2v 生成,再 ffmpeg 拼接成一条;单段则走快路径不拼接。
 *
 * 注:这是从原 processJob 原样抽出的视频路径(eng-review E1:先抽函数测试绿再加 type 分发)。
 * processJob 现按 job.type 分发到这里或其它工具的 runner。
 */
async function runVideoJob(job: JobRow): Promise<void> {
  const input = JSON.parse(job.input_json) as VideoGenInput;

  // 1. 生成前送审(文案级:长度 + 本地敏感词表)
  const pre = await moderateScript(input.script);
  if (!pre.allowed) throw new Error(`送审拒绝:${pre.reason}`);

  // 2. 解析素材:脸图 URL(全段共用同一张图)+ 音色
  const imageUrl = await resolveImageUrl(input.avatarRef, job.tenant_id);
  const { voice, model: ttsModel } = resolveVoice(input.voiceRef, job.tenant_id);

  // 3. 长文案分段(每段 <20s)。空文案在 moderate 已拦,这里至少 1 段。
  const segments = segmentScript(input.script);
  if (segments.length === 0) throw new Error('文案分段为空');
  const deadline = Date.now() + config.baichuan.jobTimeoutMs;

  // 4. 逐段渲染(免费档并发=1,串行;每段进度映射到整体的 [i/N, (i+1)/N) 区间)。
  const segVideos: Buffer[] = [];
  for (let i = 0; i < segments.length; i++) {
    const base = Math.floor((i / segments.length) * 100);
    const span = Math.floor((1 / segments.length) * 100);
    const buf = await renderSegment(
      job, i, segments[i]!, imageUrl, voice, ttsModel, input, deadline,
      (segPct) => updateProgress(job.id, Math.min(99, base + Math.floor((segPct / 100) * span))),
    );
    segVideos.push(buf);
  }

  // 5. 拼接(单段直接用;多段 ffmpeg concat)
  const merged = await concatVideos(segVideos);

  // 6. 成品送审(对拼接后的整条)
  const post = await moderateOutput('merged');
  if (!post.allowed) throw new Error(`成品送审拒绝:${post.reason}`);

  // 7. (按租户合规开关)ffmpeg 打 AI 标识 → 落 MinIO
  const objectKey = `videos/${job.tenant_id}/${job.id}.mp4`;
  const labelCfg = getAiLabelConfig(job.tenant_id);
  let aiLabel: string;
  if (labelCfg.enabled) {
    const { buffer, applied } = await applyAiLabel(merged, { text: labelCfg.text });
    await storage.putObject(objectKey, buffer, 'video/mp4');
    aiLabel = applied ? 'postprocess' : 'none'; // applied=false 说明 ffmpeg 缺失,记 none 以便告警
  } else {
    await storage.putObject(objectKey, merged, 'video/mp4');
    aiLabel = 'disabled';
  }

  markDone(job.id, objectKey, aiLabel);
  // 成功结算:按秒数×每秒售价(与提交 reserve 同一函数同一入参 script/resolution/speed → 差额0)
  const actualCost = estimateCost(input.script.length, input.resolution, input.speed);
  settle(job.tenant_id, job.id, actualCost);
}

/** 处理一个文生视频(text2video)job。与数字人 s2v 不同形状:纯文生视频,无 TTS、无图、无分段。
 *
 *   prompt 送审 → submitVideoT2V(task_id) → 轮询(独立 15 分超时,eng A1)→ 取归一 r.videoUrl(R2)
 *     → fetch Buffer → moderateOutput → applyAiLabel(同 s2v 合规尾段,eng A2)→ 落 MinIO → markDone → settle。
 *
 * 抛错由调用方捕获并标 failed(失败隔离)。 */
async function runVideoT2VJob(job: JobRow): Promise<void> {
  const input = JSON.parse(job.input_json) as VideoGenT2VInput;

  // 1. 生成前送审(提示词级)
  const pre = await moderatePrompt(input.prompt ?? '');
  if (!pre.allowed) throw new Error(`送审拒绝:${pre.reason}`);

  // 2. 网关提交(按 shape 组体,返回 task_id);resume 守卫:已有 task_id 续跑不重提交。
  const gateway = getGateway(input.model);
  const providerTaskId = await submitOrResume(job, () => gateway.submitVideoT2V(input));

  // 3. 轮询(t2v 专用更长超时:1-5 分生成 + 免费档并发=1 排队,eng A1)。取归一 r.videoUrl(R2)。
  const deadline = Date.now() + config.baichuan.videoT2vTimeoutMs;
  const done = await pollUntilDone(
    () => gateway.fetchJobStatus(providerTaskId),
    (pct) => updateProgress(job.id, Math.min(99, pct)),
    deadline,
  );
  const videoUrl = done.videoUrl;
  if (!videoUrl) throw new Error('厂商成功但未返回成品 URL');

  // 4-6. 共享尾段:抓 Buffer → 送审 → AI 标识 → 落库 → markDone → settle(eng A1)
  await finalizeVideoJob(job, videoUrl, input as unknown as Record<string, unknown>, 'video_t2v');
}

/** 视频成品尾段(eng-review A1:t2v / i2v 两处共用,镜像 finalizeImageJob)。
 *  抓成品 MP4 → moderateOutput → (按租户开关)applyAiLabel 打 AI 标识 → 落 MinIO → markDone → settle。
 *  @param costInput 原始快照 input(costFor 读快照保 reserve==settle);@param costType 'video_t2v' | 'video_i2v'。 */
export async function finalizeVideoJob(
  job: JobRow,
  videoUrl: string,
  costInput: Record<string, unknown>,
  costType: 'video_t2v' | 'video_i2v' | 'video_edit' | 'video_r2v',
): Promise<void> {
  // 抓成品 MP4 为 Buffer
  const resp = await fetch(videoUrl);
  if (!resp.ok) throw new Error(`抓取成品失败 ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());

  // 成品送审
  const post = await moderateOutput('video');
  if (!post.allowed) throw new Error(`成品送审拒绝:${post.reason}`);

  // (按租户合规开关)ffmpeg 打 AI 标识 → 落 MinIO(同 s2v 合规尾段,eng A2)
  const objectKey = `videos/${job.tenant_id}/${job.id}.mp4`;
  const labelCfg = getAiLabelConfig(job.tenant_id);
  let aiLabel: string;
  if (labelCfg.enabled) {
    const { buffer, applied } = await applyAiLabel(buf, { text: labelCfg.text });
    await storage.putObject(objectKey, buffer, 'video/mp4');
    aiLabel = applied ? 'postprocess' : 'none';
  } else {
    await storage.putObject(objectKey, buf, 'video/mp4');
    aiLabel = 'disabled';
  }

  markDone(job.id, objectKey, aiLabel);
  // 成功结算:读快照计价(与提交 reserve 同一 costFor → 差额0,reserve==settle)
  settle(job.tenant_id, job.id, costFor(costType, costInput));
}

/** 媒体类视频任务共享 runner(eng-review 2A:i2v 与视频编辑只差「是否先发布输入视频」一步,
 *  抽共享消第三份近似 worker)。镜像 runImageEditAsyncJob(送审 + publish)+ 视频尾段。
 *
 *   prompt 送审(空跳过)→ [withVideo: 输入视频送审 stub + publish 覆写 input.videoRef]
 *     → 各输入图送审 + publish 覆写 input.imageRefs → submitVideoT2V(按 task 组 media)
 *     → 轮询(videoT2vTimeoutMs)→ finalizeVideoJob(costType)。
 *
 *  publish 是就地覆写运行时 input(DB input_json 未变 → 回放仍取存储 key)。
 *  抛错由调用方捕获并标 failed(失败隔离)。 */
async function runMediaVideoJob(
  job: JobRow,
  opts: { withVideo: boolean; requireRefs: boolean; multimodal?: boolean; costType: 'video_i2v' | 'video_edit' | 'video_r2v' },
): Promise<void> {
  const input = JSON.parse(job.input_json) as VideoGenT2VInput;

  // 1. 生成前送审(提示词级)。首帧/首尾帧/wan 编辑的 prompt 可选:为空时无内容可审,跳过送审
  //    (moderatePrompt 对空串判「提示词为空」拒绝,直接传会误杀合法的无提示词任务)。
  const prompt = (input.prompt ?? '').trim();
  if (prompt) {
    const pre = await moderatePrompt(prompt);
    if (!pre.allowed) throw new Error(`送审拒绝:${pre.reason}`);
  }

  const publisher = getMediaPublisher(tenantDelivery(job.tenant_id));

  // 2a. 输入视频(仅视频编辑):送审 stub(帧级检测走 T-MODERATION-API 统一升级)+ publish 覆写
  if (opts.withVideo) {
    if (!input.videoRef) throw new Error('视频编辑缺少输入视频');
    const v = await moderateOutput('video'); // 输入视频内容送审占位(与成品同 stub 口径)
    if (!v.allowed) throw new Error(`输入视频送审拒绝:${v.reason}`);
    input.videoRef = await publisher.publish(input.videoRef);
  }

  // 2b. 输入图送审 + publish 覆写(i2v 必有;编辑 0..N 张可选)
  const refs = input.imageRefs ?? [];
  if (opts.requireRefs && refs.length === 0) throw new Error('图转影片缺少输入图');
  for (const k of refs) {
    const v = await moderateImageInput(k);
    if (!v.allowed) throw new Error(`输入图送审拒绝:${v.reason}`);
  }
  if (refs.length) input.imageRefs = await Promise.all(refs.map((k) => publisher.publish(k)));

  // 2c. 多模态参考(video_r2v):参考视频/音频送审 + 并行 publish 覆写(eng-review P1#2/Sec4)。
  //     typed 三数组各自 publish,绝不 merge 进 imageRefs(否则 wan/HH 收到 video URL 当 reference_image → 400)。
  if (opts.multimodal) {
    const vids = input.videoRefs ?? [];
    const auds = input.audioRefs ?? [];
    for (const k of vids) { const v = await moderateOutput(k); if (!v.allowed) throw new Error(`参考视频送审拒绝:${v.reason}`); }
    for (const k of auds) { const v = await moderateOutput(k); if (!v.allowed) throw new Error(`参考音频送审拒绝:${v.reason}`); }
    // Promise.all 并行 publish 全部 video/audio refs(最多 6 个,串行=6 次 OSS 往返)。
    const [pubVids, pubAuds] = await Promise.all([
      Promise.all(vids.map((k) => publisher.publish(k))),
      Promise.all(auds.map((k) => publisher.publish(k))),
    ]);
    if (pubVids.length) input.videoRefs = pubVids;
    if (pubAuds.length) input.audioRefs = pubAuds;
  }

  // 3. 网关提交(按 task 组 media)+ 轮询;resume 守卫:已有 task_id 续跑不重提交。
  const gateway = getGateway(input.model);
  const providerTaskId = await submitOrResume(job, () => gateway.submitVideoT2V(input));

  const deadline = Date.now() + config.baichuan.videoT2vTimeoutMs;
  const done = await pollUntilDone(
    () => gateway.fetchJobStatus(providerTaskId),
    (pct) => updateProgress(job.id, Math.min(99, pct)),
    deadline,
  );
  const videoUrl = done.videoUrl;
  if (!videoUrl) throw new Error('厂商成功但未返回成品 URL');

  // 4-6. 共享尾段(costFor 用原始快照 input;refs/videoRef 已覆写成公网 URL → costFor 只读快照,无碍)
  await finalizeVideoJob(job, videoUrl, input as unknown as Record<string, unknown>, opts.costType);
}

/** 图转影片(i2v):共享 runner 薄包装(行为与抽取前逐字节等价,328 既有测试兑底)。 */
async function runVideoI2VJob(job: JobRow): Promise<void> {
  return runMediaVideoJob(job, { withVideo: false, requireRefs: true, costType: 'video_i2v' });
}

/** 视频编辑(video_edit):共享 runner 薄包装(media 首元素为输入视频)。 */
async function runVideoEditJob(job: JobRow): Promise<void> {
  return runMediaVideoJob(job, { withVideo: true, requireRefs: false, costType: 'video_edit' });
}

/** 多模态参考生影片(video_r2v):共享 runner 薄包装(图/视频/音频 typed 三数组)。
 *  requireRefs:false(可纯文本 + 视频/音频);multimodal:true 启用 video/audio publish + 审核。 */
async function runVideoR2VJob(job: JobRow): Promise<void> {
  return runMediaVideoJob(job, { withVideo: false, requireRefs: false, multimodal: true, costType: 'video_r2v' });
}

/** 共享尾段:百炼图 URL → 拉进自有存储存 key → markDone(JSON key 数组,kind=image)→ settle。
 *  文生图/图生图两路都用(DRY)。
 *  ⚠️ output_url 存的是存储 key 不是 URL;百炼图 URL 24h 过期,必须 putObjectFromUrl 拉进来(外部声音 P1)。 */
async function finalizeImageJob(job: JobRow, input: ImageGenInput, imageUrls: string[]): Promise<void> {
  if (imageUrls.length === 0) throw new Error('厂商成功但未返回图片 URL');
  // 成品送审 hook(当前 passthrough,和视频一致;TODO 二期接真实图像审核)
  const post = await moderateOutput('image');
  if (!post.allowed) throw new Error(`成品送审拒绝:${post.reason}`);
  const keys: string[] = [];
  for (let i = 0; i < imageUrls.length; i++) {
    const key = `images/${job.tenant_id}/${job.id}-${i}.png`;
    await storage.putObjectFromUrl(key, imageUrls[i]!);
    keys.push(key);
  }
  markDone(job.id, JSON.stringify(keys), 'none', 'image');
  settle(job.tenant_id, job.id, costFor('ai_image', input as unknown as Record<string, unknown>));
}

/** 文生图(text2img,qwen-image,异步轮询)。从原 runImageJob 原样抽出(eng-review E1:先抽测试绿再加 mode 分发)。
 *  管线:提示词送审 → submitImage(task_id)→ 轮询 → finalize。 */
async function runImageGenJob(job: JobRow): Promise<void> {
  const input = JSON.parse(job.input_json) as ImageGenInput;

  const pre = await moderatePrompt(input.prompt);
  if (!pre.allowed) throw new Error(`送审拒绝:${pre.reason}`);

  const gateway = getGateway(input.model);
  // resume 守卫(2026-06-16 并发改造):崩溃重启后 recoverStuckJobs 把在飞 job 重入队;
  //   已有 task_id 则跳过 submit、直接轮询现有任务,避免双提交双扣费(eng-review Finding 2)。
  const providerTaskId = await submitOrResume(job, () => gateway.submitImage(input));

  // eng-review CQ1:走共享 pollUntilDone(进度封顶 99,留成功后置 100 的余地)。
  const deadline = Date.now() + config.baichuan.jobTimeoutMs;
  const done = await pollUntilDone(
    () => gateway.fetchImageStatus(providerTaskId),
    (pct) => updateProgress(job.id, Math.min(99, pct)),
    deadline,
  );
  await finalizeImageJob(job, input, done.imageUrls ?? []);
}

/** 图生图(img2img,qwen-image-edit,同步)。抛错由调用方捕获并标 failed(失败隔离)。
 *
 * 管线:提示词送审 → 输入图 key 经 publish 转公网 URL → editImage(同步,AbortController 硬超时)→ finalize。
 * ⚠️ 同步调无 poll 循环检 deadline(外部声音 P2);AbortController + setTimeout(jobTimeoutMs)是唯一防冻 worker 的保障。
 */
async function runImageEditJob(job: JobRow): Promise<void> {
  const input = JSON.parse(job.input_json) as ImageGenInput;

  const pre = await moderatePrompt(input.prompt);
  if (!pre.allowed) throw new Error(`送审拒绝:${pre.reason}`);

  const refs = input.imageRefs ?? [];
  if (refs.length === 0) throw new Error('图生图缺少输入图');
  // 输入图送审 hook(passthrough,TODO 二期;政企合规靠上传端点的 consent+proof 门票)
  for (const k of refs) {
    const v = await moderateImageInput(k);
    if (!v.allowed) throw new Error(`输入图送审拒绝:${v.reason}`);
  }
  // 输入图存储 key → 公网 URL(百炼要能下载;复用数字人同款发布策略)
  const publisher = getMediaPublisher(tenantDelivery(job.tenant_id));
  const imageUrls = await Promise.all(refs.map((k) => publisher.publish(k)));

  // 同步调:AbortController 硬超时(jobTimeoutMs)。超时→abort→fetch 抛 AbortError→冒泡标 failed+release。
  const gateway = getGateway(input.model) as unknown as import('../gateway/types.js').SyncImageGateway;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.baichuan.jobTimeoutMs);
  let resultUrls: string[];
  try {
    updateProgress(job.id, 50);
    resultUrls = await gateway.editImage(
      { model: input.model, imageUrls, prompt: input.prompt, count: input.count, ratio: input.ratio, resolution: input.resolution, seed: input.seed },
      ac.signal,
    );
  } catch (e) {
    if (ac.signal.aborted) throw new Error(`生成超时(>${config.baichuan.jobTimeoutMs}ms),已放弃`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
  await finalizeImageJob(job, input, resultUrls);
}

/** 同步文生图(S 形状 text2img,eng 外部声音 P1-a)。提示词送审 → generateImageSync(纯文本,
 *  AbortController 硬超时,同 runImageEditJob 防冻 worker)→ finalize。无输入图、无轮询。 */
async function runImageGenSyncJob(job: JobRow): Promise<void> {
  const input = JSON.parse(job.input_json) as ImageGenInput;

  const pre = await moderatePrompt(input.prompt);
  if (!pre.allowed) throw new Error(`送审拒绝:${pre.reason}`);

  const gateway = getGateway(input.model) as unknown as import('../gateway/types.js').SyncImageGateway;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.baichuan.jobTimeoutMs);
  let resultUrls: string[];
  try {
    updateProgress(job.id, 50);
    resultUrls = await gateway.generateImageSync(input, ac.signal);
  } catch (e) {
    if (ac.signal.aborted) throw new Error(`生成超时(>${config.baichuan.jobTimeoutMs}ms),已放弃`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
  await finalizeImageJob(job, input, resultUrls);
}

/** 万相2.7 异步含图编辑(A_EDIT)。= 异步轮询模板(runImageGenJob)+ 编辑前导(送审/发布输入图)。
 *  与 runImageEditJob(同步)不同:走 submitImageEdit(task_id)+ 轮询;允许 0 张输入图(纯生成 / bbox 编辑)。
 *  管线:提示词送审 → 各输入图送审 → publish 转公网 URL(写回 input.imageRefs)→ submitImageEdit → 轮询 → finalize。 */
async function runImageEditAsyncJob(job: JobRow): Promise<void> {
  const input = JSON.parse(job.input_json) as ImageGenInput;

  const pre = await moderatePrompt(input.prompt);
  if (!pre.allowed) throw new Error(`送审拒绝:${pre.reason}`);

  const refs = input.imageRefs ?? [];
  for (const k of refs) {
    const v = await moderateImageInput(k);
    if (!v.allowed) throw new Error(`输入图送审拒绝:${v.reason}`);
  }
  // 输入图存储 key → 公网 URL(百炼要能下载)。写回 input,submitImageEdit 读 imageRefs。
  const publisher = getMediaPublisher(tenantDelivery(job.tenant_id));
  input.imageRefs = await Promise.all(refs.map((k) => publisher.publish(k)));

  const gateway = getGateway(input.model);
  // resume 守卫:已有 task_id 续跑不重提交(eng-review Finding 2)。
  const providerTaskId = await submitOrResume(job, () => gateway.submitImageEdit(input));

  // eng-review CQ1:走共享 pollUntilDone(进度封顶 99)。
  const deadline = Date.now() + config.baichuan.jobTimeoutMs;
  const done = await pollUntilDone(
    () => gateway.fetchImageStatus(providerTaskId),
    (pct) => updateProgress(job.id, Math.min(99, pct)),
    deadline,
  );
  // finalize 用原始快照 input(含 count/bboxList),settle 读快照保 reserve==settle;
  // 但 imageRefs 已被改成公网 URL——costFor 不读 imageRefs,无碍。
  await finalizeImageJob(job, input, done.imageUrls ?? []);
}

/** AI 图片 job 按 (model.shape, mode) 分发(eng 外部声音 P1-b:一个模型不同 shape/mode 请求体不同)。
 *  - shape A_EDIT   → runImageEditAsyncJob(异步含图编辑,万相2.7;不论 mode)
 *  - img2img        → runImageEditJob(S 千问编辑,含图 content,同步)
 *  - text2img + S   → runImageGenSyncJob(纯文本 content,同步直返)
 *  - text2img + A1  → runImageGenJob(异步轮询,results[].url)
 *  A_EDIT 先于 img2img 特判:只有万相2.7 带 A_EDIT,故千问编辑(S+img2img)不回归。
 *  未知/缺 model → 默认(qwen-image,A1);未知/缺 mode → text2img(兼容老 job)。 */
async function runImageJob(job: JobRow): Promise<void> {
  const input = JSON.parse(job.input_json) as ImageGenInput;
  const def = getImageModel(input.model, input.mode === 'img2img' ? 'img2img' : 'text2img');
  if (def.shape === 'A_EDIT') return runImageEditAsyncJob(job);
  if (input.mode === 'img2img') return runImageEditJob(job);
  // text2img:按 model shape 选同步/异步
  return def.shape === 'S' ? runImageGenSyncJob(job) : runImageGenJob(job);
}

// 文转语音单段字数上限(cosyvoice 单次合成,远大于视频的 90 字/段——TTS 无 20s 视频约束)。
// Qwen-TTS 单次合成硬限:input 长度 ∈ [0, 600],单位是 **token**(非字符;API 实测:
// instruct 模型中文 300 字 OK、350 字 → 400 Range[0,600],即中文 ≈ 1.7-2 token/字)。
// 故按字符分段须按最坏比(中文 ~2 token/字)留余:280 字 ×2 ≈ 560 token < 600,
// 再含 instructions 的几十 token 仍安全。英文 token/字符更低,280 字符更宽松。
const TTS_MAX_CHARS = 280;

/** 处理一个文转语音(TTS,全 Qwen-TTS HTTP)job。抛错由调用方捕获并标 failed(失败隔离)。
 *
 * 管线:文本送审 → 情绪/音高→指令 → 音色解析(预置带情绪自动选 instruct)→ 分段(TTS 字数上限)
 *   → 逐段 HTTP 合成 → concatAudio → putObject(buffer)存 key → output_kind=audio。
 * 全走 Qwen-TTS MultiModalConversation(零 CosyVoice),均返 Buffer → 统一 putObject。
 *   分段防 Qwen 单次输入上限硬失败;job 级 deadline 每段前检查防多段累计跑超。
 */
async function runTtsJob(job: JobRow): Promise<void> {
  const input = JSON.parse(job.input_json) as TtsGenInput;

  // 1. 文本送审(复用 moderatePrompt)
  const pre = await moderatePrompt(input.text);
  if (!pre.allowed) throw new Error(`送审拒绝:${pre.reason}`);

  // 2. 情绪 + 语速 + 音高 → instructions(全 Qwen HTTP);有指令 → 系统音色自动用 instruct 模型
  const instruction = buildInstruction(input.emotion, input.pitch, input.rate);

  // 3. 音色解析(预置/克隆/设计,全 http;预置带情绪 → instruct,否则 flash;
  //    复刻/设计共用各自 target_model;isSystem 标识能否下发 instructions/language_type)
  const { voice, model, isSystem } = resolveVoice(input.voiceRef, job.tenant_id, !!instruction);

  // 4. instructions(情绪/语速/音高)与 language_type 仅系统音色支持(阿里官方):
  //    复刻(VC)/设计(VD)下发会 400(TTS speak request failed)→ 非系统音色一律不下发。
  const sysInstruction = isSystem ? (instruction || undefined) : undefined;
  const languageType = isSystem && input.language && input.language !== 'Auto' ? input.language : undefined;

  // 5. 分段(防 Qwen 单次 ≤600 上限,见 TTS_MAX_CHARS)+ job 级 deadline
  const segments = segmentScript(input.text, TTS_MAX_CHARS);
  if (segments.length === 0) throw new Error('文本分段为空');
  const deadline = Date.now() + config.baichuan.jobTimeoutMs;

  const audioBufs: Buffer[] = [];
  for (let i = 0; i < segments.length; i++) {
    if (Date.now() > deadline) throw new Error(`生成超时(>${config.baichuan.jobTimeoutMs}ms),已放弃`);
    updateProgress(job.id, Math.min(99, Math.floor((i / segments.length) * 100)));
    audioBufs.push(await synthesizeSpeechHttp({ text: segments[i]!, voice, model, instruction: sysInstruction, languageType }));
  }

  // 6. 拼接(单段直返不调 ffmpeg)+ 落存储(返 Buffer → putObject,非 putObjectFromUrl)
  const merged = await concatAudio(audioBufs);
  const key = `audio/${job.tenant_id}/${job.id}.mp3`;
  await storage.putObject(key, merged, 'audio/mpeg');

  markDone(job.id, JSON.stringify([key]), 'none', 'audio');
  settle(job.tenant_id, job.id, costFor('tts', input as unknown as Record<string, unknown>));
}

/** 处理一个 AI 音乐(Fun-Music)job。抛错由调用方捕获并标 failed(失败隔离)。
 *
 * 管线:送审(prompt/lyrics)→ generateMusic(同步返 url+lyrics+duration)→ putObjectFromUrl
 *   (Fun-Music 返 24h URL,当场拉进存储)→ 写回 duration/lyrics 快照 → markDone(audio)→
 *   按实际 duration 结算且封顶 reserved(只退不补,绝不负余额)。
 */
async function runAiMusicJob(job: JobRow): Promise<void> {
  const input = JSON.parse(job.input_json) as AiMusicGenInput;

  // 1. 送审(prompt 与 lyrics 至少一个,送有内容的那个)
  const moderateText = input.lyrics || input.prompt || '';
  const pre = await moderatePrompt(moderateText);
  if (!pre.allowed) throw new Error(`送审拒绝:${pre.reason}`);

  updateProgress(job.id, 8);
  // 2. 生成(同步;邀测未开通/非北京地域会在此抛可读错误,透传给前端)
  const result = await generateMusic({
    model: input.model ?? config.baichuan.funMusicModel,
    prompt: input.prompt,
    lyrics: input.lyrics,
    gender: input.mode === 'song' ? input.gender : undefined,
  });
  updateProgress(job.id, 80);

  // 3. 落存储(Fun-Music 返 URL,24h → 拉进本地/OSS 持久化)
  const ext = 'mp3';
  const key = `audio/${job.tenant_id}/${job.id}.${ext}`;
  await storage.putObjectFromUrl(key, result.url);

  // 4. 写回快照(实际 duration 供结算;lyrics 供前端记录卡展示)
  const finalInput = { ...input, durationSnapshot: result.duration, lyricsResult: result.lyrics };
  db.prepare('UPDATE job SET input_json=? WHERE id=?').run(JSON.stringify(finalInput), job.id);

  markDone(job.id, JSON.stringify([key]), 'none', 'audio');

  // 5. 结算:按实际秒数,且封顶 reserved(actual ≤ reserve → 只退不补,不击穿负余额)
  const actual = costFor('ai_music', finalInput as unknown as Record<string, unknown>);
  const capped = Math.min(actual, reservedFor(job.id));
  settle(job.tenant_id, job.id, capped);
}

/** 按 job.type 分发到对应工具的 runner(eng-review E1)。
 *  抛错由调用方捕获并标 failed(失败隔离)。未知 type → 抛错标失败(防御,不崩 worker)。 */
async function processJob(job: JobRow): Promise<void> {
  switch (job.type) {
    case 'video':
      return runVideoJob(job);
    case 'video_t2v':
      return runVideoT2VJob(job);
    case 'video_i2v':
      return runVideoI2VJob(job);
    case 'video_r2v':
      return runVideoR2VJob(job);
    case 'video_edit':
      return runVideoEditJob(job);
    case 'ai_image':
      return runImageJob(job);
    case 'tts':
      return runTtsJob(job);
    case 'ai_music':
      return runAiMusicJob(job);
    default:
      throw new Error(`未知任务类型:${job.type}`);
  }
}

let running = false;
let stopped = false;

/**
 * 启动 worker 轮询循环。失败隔离的关键就在这个 try/catch:
 * processJob 无论怎么抛,都只标当前 job failed,循环继续拉下一个。
 */
/**
 * 启动恢复(2026-06-16 并发改造重写,eng-review Finding 2 + 外部声音 #3/#4)。
 *
 * 为什么需要:进程跑到一半被 docker restart / OOM / 部署更新杀掉,job 卡在 running —
 * claimNextJob 只领 queued 永不重领它,用户预扣积分也不释放。
 *
 * 旧实现「盲标 failed + release」是 bug:厂商任务可能在重启窗口已生成完,盲标会
 * 误杀已完成作品 + 错退款。串行时一次炸 1 个,并发池一次炸最多 poolSize 个。
 *
 * 现为「重新入队」让 runner 续跑(复用全套 runner + finalize,最大 DRY):
 *   - 有 baichuan_task_id → 留着,runner 的 submitOrResume 跳过 submit、续跑现有厂商任务。
 *     轮询立刻拿到 succeeded → 走正常 finalize 落地;仍在跑则继续轮询;查不到则正常标 failed+release。
 *   - 无 task_id(同步图片 job claim 后秒级未提交 / 异步 claim 后崩在 submit 前)→ 重入队从头跑。
 *     reserve 已预扣未 settle,重跑安全(双生成最多浪费一次厂商调用,不双扣费)。
 *
 * 启动时 active=0 且单进程,这里看到的 running 一定是上次残留,安全重入队。
 * 重入队不动 baichuan_task_id / created_at(保 FIFO 与续跑能力),只把 status 回 queued。
 */
export function recoverStuckJobs(): void {
  const rows = db
    .prepare(`SELECT id, baichuan_task_id FROM job WHERE status='running'`)
    .all() as { id: string; baichuan_task_id: string | null }[];
  if (!rows.length) return;
  const t = Date.now();
  const requeue = db.prepare(`UPDATE job SET status='queued', started_at=NULL, updated_at=? WHERE id=? AND status='running'`);
  const tx = db.transaction(() => {
    for (const r of rows) requeue.run(t, r.id);
  });
  tx();
  const withTask = rows.filter((r) => r.baichuan_task_id).length;
  console.log(
    `[worker] 启动恢复:${rows.length} 个中断任务重新入队(${withTask} 个带厂商 task_id 将续跑,${rows.length - withTask} 个从头跑)`,
  );
}

// 当前在飞 job 数(并发池槽占用)。dashboard「进行中 N / 容量 M」与测试读它。
let active = 0;
/** 当前在飞 job 数(并发池实占槽)。 */
export function activeJobCount(): number {
  return active;
}
/** 并发池容量(同时可跑的 job 上限)。 */
export function workerPoolSize(): number {
  return config.worker.poolSize;
}

/**
 * 启动 worker 并发池(2026-06-16 并发改造)。
 *
 * 旧实现是单循环 `claim(); await processJob()` —— 串行,进行中永远=1。
 * 现为 N 槽池:维持最多 poolSize 个 processJob 在飞,每槽跑完即领下一个。
 * job 是 I/O 密集(轮询远程,~零 CPU),一个 Node 进程并行数十个没问题。
 * claimNextJob 已单语句原子 + per-tenant cap,多槽同 tick 领取安全。
 *
 *   ┌──────────────────────────────────────────────────────┐
 *   │ while(!stopped):                                      │
 *   │   while active < poolSize 且 claimNextJob() 有 job:   │  ← 尽量填满槽
 *   │     active++; processJob(job).finally(active--)       │  ← 不 await,并发跑
 *   │   await sleep(无 job 时 1000ms,否则短歇)             │
 *   └──────────────────────────────────────────────────────┘
 */
export function startWorker(): void {
  if (running) return;
  running = true;
  stopped = false;

  recoverStuckJobs(); // 进池前先归位上次崩溃残留(此时 active=0,单进程)
  installShutdownHandlers(); // 优雅关机:SIGTERM/SIGINT 停领 + 让在飞 job 留 running 待重调

  const runOne = (job: JobRow): void => {
    active++;
    // Promise.resolve().then 包一层:即便 processJob 同步抛(promise 创建前),
    // .finally 也一定执行 → active 不泄漏(eng-review Finding:sync-throw 防 desync)。
    Promise.resolve()
      .then(() => processJob(job))
      .catch((err) => {
        // 关机中断:job 留 running(不标 failed、不退预扣),启动重调归位。
        if (err instanceof WorkerStoppingError) return;
        // 失败隔离:单 job 异常只影响它自己,池不中断。
        const msg = err instanceof Error ? err.message : String(err);
        markFailed(job.id, msg);
        release(job.tenant_id, job.id); // 失败释放预扣,失败不扣(设计文档积分语义)
      })
      .finally(() => {
        active--;
      });
  };

  (async () => {
    while (!stopped) {
      workerHeartbeat = Date.now(); // 心跳:证明轮询活着(看门狗据此区分「卡住」vs「worker 死了」)
      let claimedThisRound = false;
      // 填槽:有空位且有 queued + 未被 cap 挡住,就一直领。
      while (!stopped && active < config.worker.poolSize) {
        let job: JobRow | null = null;
        try {
          job = claimNextJob();
        } catch {
          break; // claim 本身异常(极少),歇一下下一轮再试,避免热循环
        }
        if (!job) break; // 无可领(队列空 / 全被 cap 挡)
        claimedThisRound = true;
        runOne(job);
      }
      // 有活在跑就短歇(快速回来补槽);全空闲就长歇(省 CPU)。
      await sleep(claimedThisRound || active > 0 ? 150 : 1000);
    }
    running = false;
  })();

  startQueueWatchdog();
}

// ── 队列看门狗:防 queued job 静默卡死(worker 活着却始终领不到它)──
// 现有 recoverStuckJobs 只管「卡 running」(崩溃残留);queued 卡住(如 worker 曾死过、
// 池被异常占满)无人兜底,用户会看到任务排队几十分钟无果。看门狗补这个洞:
//   - worker 心跳新鲜(<2× 长歇间隔)= worker 活着;此时仍有 job 排队超 queuedTimeoutMs
//     → 判定真卡住,标 failed + 退预扣(只退不补,与失败语义一致)。
//   - 心跳过期(worker 死/卡)→ 不误杀等待中的正常 job,交给进程重启的 recoverStuckJobs。
let workerHeartbeat = 0;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
const HEARTBEAT_FRESH_MS = 5_000; // 心跳超过此值未更新 = worker 不在正常轮询
function startQueueWatchdog(): void {
  if (watchdogTimer) return;
  const checkMs = 60_000; // 每分钟扫一次
  watchdogTimer = setInterval(() => {
    if (stopped) return;
    // worker 心跳必须新鲜,才敢判定「卡住」(否则是 worker 死了,等重启 recover,不误杀)
    if (Date.now() - workerHeartbeat > HEARTBEAT_FRESH_MS) return;
    const cutoff = Date.now() - config.worker.queuedTimeoutMs;
    let stale: { id: string; tenant_id: string }[];
    try {
      stale = db
        .prepare(`SELECT id, tenant_id FROM job WHERE status='queued' AND created_at < ?`)
        .all(cutoff) as { id: string; tenant_id: string }[];
    } catch {
      return;
    }
    for (const j of stale) {
      // 二次确认仍是 queued(避免与 claimNextJob 竞态:刚被领走就别标 failed)
      const r = db
        .prepare(`UPDATE job SET status='failed', error=?, updated_at=? WHERE id=? AND status='queued'`)
        .run('排队超时:长时间未能进入生成(服务繁忙或调度异常),已退还预扣积分,请重试', Date.now(), j.id);
      if (r.changes === 1) {
        release(j.tenant_id, j.id); // 退预扣(只退不补)
        console.warn(`[worker] 看门狗:job ${j.id} 排队超时,标 failed + 退预扣`);
      }
    }
  }, checkMs);
  if (typeof watchdogTimer.unref === 'function') watchdogTimer.unref();
}

/**
 * 停止领新任务(优雅关机第一步)。在飞 job 不强杀:
 *   - 同步图片 job(秒级)会自然跑完;
 *   - 长视频 job 的 pollUntilDone 检测到 stopped 会跳出,job 留 running,
 *     交给下次启动的 recoverStuckJobs 按 task_id 重调归位(不在此标 failed)。
 * 真正的安全网是启动重调,而非排空等待(eng-review Finding 1)。
 */
export function stopWorker(): void {
  stopped = true;
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
}

/** worker 是否已收到停止信号(pollUntilDone 据此提前跳出)。 */
export function isStopping(): boolean {
  return stopped;
}

let shutdownInstalled = false;
/**
 * 优雅关机(eng-review Finding 1:重调为主、排空尽力而为)。
 * SIGTERM(部署/容器停)/ SIGINT(Ctrl-C)→ stopWorker():
 *   - 停领新任务;
 *   - 在飞同步图片 job(秒级)自然跑完;
 *   - 长视频 job 的 pollUntilDone 检测 stopped 跳出 → 留 running,下次启动 recoverStuckJobs 续跑。
 * 短 grace 等接近完成的同步 job(容器默认 SIGKILL 前有几秒);长 job 排不空是预期,靠重调兜底。
 * 不在 handler 里强制 exit:让进程管理器/容器按自己的 grace 收尾,避免与其他清理竞争。
 */
function installShutdownHandlers(): void {
  if (shutdownInstalled) return;
  shutdownInstalled = true;
  const onSignal = (sig: string) => {
    console.log(`[worker] 收到 ${sig},停止领取新任务,在飞任务留待重调...`);
    stopWorker();
  };
  process.once('SIGTERM', () => onSignal('SIGTERM'));
  process.once('SIGINT', () => onSignal('SIGINT'));
}

/** 测试用:处理恰好一个任务(若有),返回是否处理了任务。 */
export async function tick(): Promise<boolean> {
  let job: JobRow | null = null;
  try {
    job = claimNextJob();
    if (!job) return false;
    await processJob(job);
    return true;
  } catch (err) {
    if (err instanceof WorkerStoppingError) return true; // 关机中断:job 留 running
    const msg = err instanceof Error ? err.message : String(err);
    if (job) {
      markFailed(job.id, msg);
      release(job.tenant_id, job.id); // 失败释放预扣
    }
    return true; // 处理了(虽然失败)
  }
}
