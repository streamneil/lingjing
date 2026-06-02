// 灵镜 worker — 拉任务、跑生成管线、写回状态。
//
// 失败隔离(/plan-eng-review D7,护城河卵论点):每个 job 的处理包在 try/catch 里,
// 单个 job 抛错只把自己标 failed,绝不冒泡到轮询循环 → 一个坏任务不影响其它任务、
// 不拖垮 worker、不影响平台可用性。失败隔离 E2E 专门验证这一点。
//
// 管线:moderate(文案) → 网关提交 → 轮询直到完成/超时 → moderate(成品) → 落 MinIO → markDone

import { config } from '../config.js';
import { getGateway } from '../gateway/baichuan.js';
import type { VideoGenInput } from '../gateway/types.js';
import { storage } from '../storage/index.js';
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

/** 处理单个 job 的完整管线。抛错由调用方捕获并标 failed(失败隔离)。 */
async function processJob(job: JobRow): Promise<void> {
  const input = JSON.parse(job.input_json) as VideoGenInput;

  // 1. 生成前送审(Slice1 空实现 + 基础校验)
  const pre = await moderateScript(input.script);
  if (!pre.allowed) throw new Error(`送审拒绝:${pre.reason}`);

  // 2. 网关提交(厂商无关)
  const gateway = getGateway(job.tenant_id);
  const providerTaskId = await gateway.submitVideo(input);
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
