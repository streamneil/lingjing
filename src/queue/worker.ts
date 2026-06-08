// 灵镜 worker — 拉任务、跑生成管线、写回状态。
//
// 失败隔离(/plan-eng-review D7,护城河卵论点):每个 job 的处理包在 try/catch 里,
// 单个 job 抛错只把自己标 failed,绝不冒泡到轮询循环 → 一个坏任务不影响其它任务、
// 不拖垮 worker、不影响平台可用性。失败隔离 E2E 专门验证这一点。
//
// 管线:moderate(文案) → 网关提交 → 轮询直到完成/超时 → moderate(成品) → 落 MinIO → markDone

import { config } from '../config.js';
import { getGateway } from '../gateway/baichuan.js';
import { synthesizeSpeech } from '../gateway/cosyvoice.js';
import { getMediaPublisher, tenantDelivery } from '../gateway/media-publisher.js';
import type { VideoGenInput, VideoSubmitUrls, ImageGenInput } from '../gateway/types.js';
import { storage } from '../storage/index.js';
import { listPresets as listAvatarPresets, getAvatar } from '../avatars/index.js';
import { isPreset as isPresetVoice, getVoice } from '../voices/index.js';
import { moderateScript, moderatePrompt, moderateImageInput, moderateOutput } from '../pipeline/moderation.js';
import { applyAiLabel, probeAudioDuration, concatVideos } from '../pipeline/ai-label.js';
import { segmentScript } from '../pipeline/segment.js';
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

/** 把 voiceRef 解析为 {voice, model}。
 *  预置音色用 ttsModel(v1,免费、够用);克隆音色用 cloneModel(v3.5,保真度高,
 *  复刻与合成必须同模型)。复刻未产出则回退预置(v1)。 */
function resolveVoice(voiceRef: string, tenantId: string): { voice: string; model: string } {
  if (isPresetVoice(voiceRef)) return { voice: voiceRef, model: config.baichuan.ttsModel };
  const clone = getVoice(voiceRef, tenantId);
  if (clone?.provider_voice_id) {
    // 真实声音复刻:voice_id + 同复刻模型 = 本人声音
    return { voice: clone.provider_voice_id, model: config.baichuan.cloneModel };
  }
  // 克隆未产出 / 解析失败:回退预置音色(v1),避免任务整体失败
  return { voice: DEFAULT_PRESET_VOICE, model: config.baichuan.ttsModel };
}

// 默认回退音色:cosyvoice-v1 合法音色名(新闻播报场景)
const DEFAULT_PRESET_VOICE = 'longjing';

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
  // 1. 文案 → CosyVoice TTS → 音频
  const audioBuf = await synthesizeSpeech({
    text: segScript, voice, model: ttsModel,
    rate: input.speed ?? 1, volume: input.volume ?? 50,
  });
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

  // 3. 轮询直到完成 / 失败 / 超时(超时上限为整 job 共享,防永久 running)
  let videoUrl: string | undefined;
  let sawRunning = false;
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(
        sawRunning
          ? `生成超时(>${config.baichuan.jobTimeoutMs}ms),已放弃`
          : `排队超时:生成服务繁忙(免费档同时只跑 1 个任务),请稍后重试或减少并发`,
      );
    }
    const r = await gateway.fetchJobStatus(providerTaskId);
    if (r.status === 'running') sawRunning = true;
    // 段内进度细分(0-100)再由 onProgress 映射到整 job 的该段区间。
    if (typeof r.progress === 'number') onProgress(r.progress);
    else if (r.status === 'running') onProgress(50);
    else onProgress(5);
    if (r.status === 'succeeded') { videoUrl = r.videoUrl; break; }
    if (r.status === 'failed') throw new Error(r.error ?? '厂商任务失败');
    await sleep(config.baichuan.pollIntervalMs);
  }
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

  const deadline = Date.now() + config.baichuan.jobTimeoutMs;
  let imageUrls: string[] = [];
  let sawRunning = false;
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(
        sawRunning
          ? `生成超时(>${config.baichuan.jobTimeoutMs}ms),已放弃`
          : `排队超时:生成服务繁忙(免费档同时只跑 1 个任务),请稍后重试`,
      );
    }
    const r = await gateway.fetchImageStatus(providerTaskId);
    if (r.status === 'running') sawRunning = true;
    if (typeof r.progress === 'number') updateProgress(job.id, Math.min(99, r.progress));
    else updateProgress(job.id, r.status === 'running' ? 50 : 5);
    if (r.status === 'succeeded') { imageUrls = r.imageUrls ?? []; break; }
    if (r.status === 'failed') throw new Error(r.error ?? '厂商图片任务失败');
    await sleep(config.baichuan.pollIntervalMs);
  }
  await finalizeImageJob(job, input, imageUrls);
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
      { imageUrls, prompt: input.prompt, ratio: input.ratio, resolution: input.resolution },
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

/** AI 图片 job 按 input.mode 分发(eng-review E1)。
 *  text2img(异步轮询)/ img2img(同步)。未知/缺 mode 默认 text2img(兼容老 job)。 */
async function runImageJob(job: JobRow): Promise<void> {
  const input = JSON.parse(job.input_json) as ImageGenInput;
  switch (input.mode) {
    case 'img2img':
      return runImageEditJob(job);
    case 'text2img':
    default:
      return runImageGenJob(job);
  }
}

/** 按 job.type 分发到对应工具的 runner(eng-review E1)。
 *  抛错由调用方捕获并标 failed(失败隔离)。未知 type → 抛错标失败(防御,不崩 worker)。 */
async function processJob(job: JobRow): Promise<void> {
  switch (job.type) {
    case 'video':
      return runVideoJob(job);
    case 'ai_image':
      return runImageJob(job);
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
