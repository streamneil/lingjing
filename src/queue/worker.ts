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
import { buildInstruction } from '../gateway/tts-models.js';
import { getMediaPublisher, tenantDelivery } from '../gateway/media-publisher.js';
import type { VideoGenInput, VideoSubmitUrls, ImageGenInput, TtsGenInput, VideoGenT2VInput, ProviderJobStatus } from '../gateway/types.js';
import { storage } from '../storage/index.js';
import { listPresets as listAvatarPresets, getAvatar } from '../avatars/index.js';
import { isPreset as isPresetVoice, getVoice } from '../voices/index.js';
import { moderateScript, moderatePrompt, moderateImageInput, moderateOutput } from '../pipeline/moderation.js';
import { applyAiLabel, probeAudioDuration, concatVideos } from '../pipeline/ai-label.js';
import { segmentScript } from '../pipeline/segment.js';
import { concatAudio } from '../pipeline/concat-audio.js';
import { getImageModel } from '../gateway/image-models.js';
import { settle, release, estimateCost, costFor } from '../credits/index.js';
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
  if (preset) return preset.thumb; // 预置外链本就公网可达
  const custom = getAvatar(avatarRef, tenantId);
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
): { voice: string; model: string } {
  const presetModel = withEmotion ? config.baichuan.qwenInstructModel : config.baichuan.qwenTtsModel;
  if (isPresetVoice(voiceRef)) return { voice: voiceRef, model: presetModel };
  const v = getVoice(voiceRef, tenantId);
  if (v?.provider_voice_id) {
    if (v.kind === 'design') return { voice: v.provider_voice_id, model: config.baichuan.designModel };
    // 克隆(VC):voice + 同 target_model 合成
    return { voice: v.provider_voice_id, model: config.baichuan.vcModel };
  }
  // 克隆/设计未产出 / 解析失败:回退预置音色(Qwen),避免任务整体失败
  return { voice: DEFAULT_PRESET_VOICE, model: presetModel };
}

// 默认回退音色:Qwen-TTS 合法音色名(专业播音场景)
const DEFAULT_PRESET_VOICE = 'Neil';

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
  const audioKey = `tts/${job.tenant_id}/${job.id}-seg${segIndex}.mp3`;
  await storage.putObject(audioKey, audioBuf, 'audio/mpeg');
  const audioUrl = await getMediaPublisher(tenantDelivery(job.tenant_id)).publish(audioKey);

  // 2. 网关提交(wan2.2-s2v:image_url + audio_url)
  const submitRes: '480P' | '720P' = input.resolution === '480P' ? '480P' : '720P';
  const urls: VideoSubmitUrls = { imageUrl, audioUrl, resolution: submitRes };
  const gateway = getGateway(job.tenant_id);
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
  // 成功结算:实扣按字数估算(与提交时 reserve 同一算法 → 差额0)
  const actualCost = estimateCost(input.script.length, input.resolution);
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

  // 2. 网关提交(按 shape 组体,返回 task_id)
  const gateway = getGateway(job.tenant_id);
  const providerTaskId = await gateway.submitVideoT2V(input);
  setProviderTaskId(job.id, providerTaskId);

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
  costType: 'video_t2v' | 'video_i2v' | 'video_edit',
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
  opts: { withVideo: boolean; requireRefs: boolean; costType: 'video_i2v' | 'video_edit' },
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

  // 3. 网关提交(按 task 组 media)+ 轮询
  const gateway = getGateway(job.tenant_id);
  const providerTaskId = await gateway.submitVideoT2V(input);
  setProviderTaskId(job.id, providerTaskId);

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

  const gateway = getGateway(job.tenant_id);
  const providerTaskId = await gateway.submitImage(input);
  setProviderTaskId(job.id, providerTaskId);

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
  const gateway = getGateway(job.tenant_id) as unknown as import('../gateway/types.js').SyncImageGateway;
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

  const gateway = getGateway(job.tenant_id) as unknown as import('../gateway/types.js').SyncImageGateway;
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

  const gateway = getGateway(job.tenant_id);
  const providerTaskId = await gateway.submitImageEdit(input);
  setProviderTaskId(job.id, providerTaskId);

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
const TTS_MAX_CHARS = 2000;

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

  // 2. 情绪 + 音高 → instructions(全 Qwen HTTP);有指令 → 系统音色自动用 instruct 模型
  const instruction = buildInstruction(input.emotion, input.pitch);

  // 3. 音色解析(预置/克隆/设计,全 http;预置带情绪 → instruct,否则 flash;
  //    复刻/设计共用各自 target_model,情绪指令仅系统音色支持故忽略)
  const { voice, model } = resolveVoice(input.voiceRef, job.tenant_id, !!instruction);

  // 4. 分段(防 Qwen 单次输入上限)+ job 级 deadline
  const segments = segmentScript(input.text, TTS_MAX_CHARS);
  if (segments.length === 0) throw new Error('文本分段为空');
  const deadline = Date.now() + config.baichuan.jobTimeoutMs;

  const audioBufs: Buffer[] = [];
  for (let i = 0; i < segments.length; i++) {
    if (Date.now() > deadline) throw new Error(`生成超时(>${config.baichuan.jobTimeoutMs}ms),已放弃`);
    updateProgress(job.id, Math.min(99, Math.floor((i / segments.length) * 100)));
    audioBufs.push(await synthesizeSpeechHttp({ text: segments[i]!, voice, model, instruction: instruction || undefined }));
  }

  // 5. 拼接(单段直返不调 ffmpeg)+ 落存储(返 Buffer → putObject,非 putObjectFromUrl)
  const merged = await concatAudio(audioBufs);
  const key = `audio/${job.tenant_id}/${job.id}.mp3`;
  await storage.putObject(key, merged, 'audio/mpeg');

  markDone(job.id, JSON.stringify([key]), 'none', 'audio');
  settle(job.tenant_id, job.id, costFor('tts', input as unknown as Record<string, unknown>));
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
    case 'video_edit':
      return runVideoEditJob(job);
    case 'ai_image':
      return runImageJob(job);
    case 'tts':
      return runTtsJob(job);
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
 * 启动恢复:把上次进程退出时卡在 running 的 job 标 failed + 释放预扣积分。
 *
 * 为什么需要:单进程跑到一半被 docker restart / OOM / 部署更新杀掉,
 * 该 job 永远停在 running —— claimNextJob 只领 queued,永不重领它,
 * 用户预扣的积分也不会 release(收入/信任问题,Docker 部署就绪 D11)。
 *
 * 单进程模型下 startWorker 时不会有"真正在跑"的 running,所以这里看到的
 * running 一定是上次崩溃的残留,安全地全部标失败。复用 catch 分支同款
 * markFailed + release(per-(tenant,job),故先 SELECT 拿 tenant_id)。
 */
export function recoverStuckJobs(): void {
  const rows = db
    .prepare(`SELECT id, tenant_id FROM job WHERE status='running'`)
    .all() as { id: string; tenant_id: string }[];
  for (const r of rows) {
    markFailed(r.id, '服务重启中断,请重新发起生成');
    release(r.tenant_id, r.id); // 释放预扣积分(失败不扣)
  }
  if (rows.length) console.log(`[worker] 启动恢复:${rows.length} 个中断的 running 任务已标失败 + 释放积分`);
}

export function startWorker(): void {
  if (running) return;
  running = true;
  stopped = false;

  recoverStuckJobs(); // 进队列循环前先清理上次崩溃残留

  (async () => {
    while (!stopped) {
      let job: JobRow | null = null;
      try {
        job = claimNextJob();
        if (!job) {
          await sleep(1000); // 无任务,空转等待
          continue;
        }
        await processJob(job);
      } catch (err) {
        // 失败隔离:单 job 异常只影响它自己,循环不中断。
        const msg = err instanceof Error ? err.message : String(err);
        if (job) {
          markFailed(job.id, msg);
          release(job.tenant_id, job.id); // 失败释放预扣,失败不扣(设计文档积分语义)
        } else await sleep(1000); // claim 本身异常,稍等再试,避免热循环
      }
    }
    running = false;
  })();
}

export function stopWorker(): void {
  stopped = true;
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
    const msg = err instanceof Error ? err.message : String(err);
    if (job) {
      markFailed(job.id, msg);
      release(job.tenant_id, job.id); // 失败释放预扣
    }
    return true; // 处理了(虽然失败)
  }
}
