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
import type { VideoGenInput, VideoSubmitUrls } from '../gateway/types.js';
import { storage, getSignedUrl } from '../storage/index.js';
import { listPresets as listAvatarPresets, getAvatar } from '../avatars/index.js';
import { isPreset as isPresetVoice, getVoice } from '../voices/index.js';
import { moderateScript, moderateOutput } from '../pipeline/moderation.js';
import { settle, release, estimateCost } from '../credits/index.js';
import {
  claimNextJob,
  setProviderTaskId,
  updateProgress,
  markDone,
  markFailed,
  type JobRow,
} from './index.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 把 avatarRef 解析为公网可访问的脸图 URL(预置=外链;自定义=MinIO 签名 URL)。 */
async function resolveImageUrl(avatarRef: string, tenantId: string): Promise<string> {
  const preset = listAvatarPresets().find((p) => p.id === avatarRef);
  if (preset) return preset.thumb;
  const custom = getAvatar(avatarRef, tenantId);
  if (custom?.source_key) return getSignedUrl(custom.source_key);
  throw new Error(`形象不可用:${avatarRef}`);
}

/** 把 voiceRef 解析为 CosyVoice 可用的音色标识。 */
function resolveVoiceName(voiceRef: string, tenantId: string): string {
  if (isPresetVoice(voiceRef)) return voiceRef; // 预置音色名直接用
  const clone = getVoice(voiceRef, tenantId);
  if (clone) return clone.id; // 克隆音色 id(真实克隆音色由百炼声音复刻产出)
  // 兜底:用默认预置,避免整个任务因音色解析失败而崩
  return 'longxiaochun';
}

/** 处理单个 job 的完整管线。抛错由调用方捕获并标 failed(失败隔离)。 */
async function processJob(job: JobRow): Promise<void> {
  const input = JSON.parse(job.input_json) as VideoGenInput;

  // 1. 生成前送审(Slice1 空实现 + 基础校验)
  const pre = await moderateScript(input.script);
  if (!pre.allowed) throw new Error(`送审拒绝:${pre.reason}`);

  // 2. 解析素材为 wan2.2-s2v 需要的公网 URL:
  //    2a. 脸图 URL(预置外链 / 自定义 MinIO 签名)
  const imageUrl = await resolveImageUrl(input.avatarRef, job.tenant_id);
  //    2b. 文案 → CosyVoice TTS → 音频 → 落 MinIO → 公网签名 URL
  //        (wan2.2-s2v 不做 TTS,需现成音频;这是查证后的真实链路)
  const voice = resolveVoiceName(input.voiceRef, job.tenant_id);
  const audioBuf = await synthesizeSpeech({ text: input.script, voice });
  const audioKey = `tts/${job.tenant_id}/${job.id}.mp3`;
  await storage.putObject(audioKey, audioBuf, 'audio/mpeg');
  const audioUrl = await getSignedUrl(audioKey);

  // 3. 网关提交(wan2.2-s2v:image_url + audio_url)
  const submitRes: '480P' | '720P' = input.resolution === '480P' ? '480P' : '720P';
  const urls: VideoSubmitUrls = { imageUrl, audioUrl, resolution: submitRes };
  const gateway = getGateway(job.tenant_id);
  const providerTaskId = await gateway.submitVideo(urls);
  setProviderTaskId(job.id, providerTaskId);

  // 3. 轮询直到完成 / 失败 / 超时(超时上限防永久 running 的静默失败)
  const deadline = Date.now() + config.baichuan.jobTimeoutMs;
  let videoUrl: string | undefined;
  let aiLabel = 'none';
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(`生成超时(>${config.baichuan.jobTimeoutMs}ms),已放弃`);
    }
    const r = await gateway.fetchJobStatus(providerTaskId);
    if (typeof r.progress === 'number') updateProgress(job.id, r.progress);
    if (r.status === 'succeeded') {
      videoUrl = r.videoUrl;
      aiLabel = r.aiLabel ?? 'none';
      break;
    }
    if (r.status === 'failed') {
      throw new Error(r.error ?? '厂商任务失败');
    }
    await sleep(config.baichuan.pollIntervalMs);
  }
  if (!videoUrl) throw new Error('厂商成功但未返回成品 URL');

  // 4. 成品送审
  const post = await moderateOutput(videoUrl);
  if (!post.allowed) throw new Error(`成品送审拒绝:${post.reason}`);

  // 5. 抓成品落 MinIO(不依赖厂商临时 URL 过期),记成品 key
  const objectKey = `videos/${job.tenant_id}/${job.id}.mp4`;
  await storage.putObjectFromUrl(objectKey, videoUrl);

  // TODO(C-code 探明后): 若 aiLabel==='none',此处用 ffmpeg 后处理加合规水印/元数据。

  markDone(job.id, objectKey, aiLabel);
  // 成功结算:实扣按字数估算(与提交时 reserve 同一算法 → 差额0)
  const actualCost = estimateCost(input.script.length, input.resolution);
  settle(job.tenant_id, job.id, actualCost);
}

let running = false;
let stopped = false;

/**
 * 启动 worker 轮询循环。失败隔离的关键就在这个 try/catch:
 * processJob 无论怎么抛,都只标当前 job failed,循环继续拉下一个。
 */
export function startWorker(): void {
  if (running) return;
  running = true;
  stopped = false;

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
