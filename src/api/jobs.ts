// 灵镜 API — 任务路由(Slice 2:接入鉴权 + 租户隔离)。
//
// 决策来源:/plan-eng-review D4(DB 真相 + 轮询)+ 验收第8条(viewer 不能发起生成)。
// 所有读写经 tenant-scoped 查询,杜绝跨租户串数据。

import { Router, type Request, type Response } from 'express';
import {
  enqueueJob,
  getJobForTenant,
  listJobsForTenant,
  retryJob,
  deleteJobForTenant,
} from '../queue/index.js';
import { signOutputUrls } from '../storage/index.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { estimateCost, estimateImageCost, clampImageCount, reserve, balance } from '../credits/index.js';
import { audit } from '../audit/index.js';
import { isUsableAvatar } from '../avatars/index.js';
import { isUsableVoice } from '../voices/index.js';
import type { VideoGenInput, ImageGenInput } from '../gateway/types.js';

export const jobsRouter = Router();

// ── type 封闭 allowlist(eng-review E2 / 外部声音 P2)──
// 只接受这里登记的 type;未知/`__proto__`/空 → 400。每个 type 有自己的 input 校验器 + 计价。
// 新工具接后端时在此加一条(与 prototype/tools.js 的 enabled 工具对齐)。
type JobBuildResult =
  | { ok: true; type: string; input: Record<string, unknown>; cost: number }
  | { ok: false; status: number; error: string; extra?: Record<string, unknown> };

/** 校验并构建 video(AI 虚拟人)job 入参 + 计价。 */
function buildVideoJob(body: Record<string, unknown>, tid: string): JobBuildResult {
  const { avatarRef, voiceRef, script, resolution, ratio, speed, volume } =
    body as Partial<VideoGenInput>;
  if (!avatarRef || typeof avatarRef !== 'string')
    return { ok: false, status: 400, error: '缺少 avatarRef(形象)' };
  if (!voiceRef || typeof voiceRef !== 'string')
    return { ok: false, status: 400, error: '缺少 voiceRef(音色)' };
  if (!script || typeof script !== 'string' || script.trim().length === 0)
    return { ok: false, status: 400, error: '缺少 script(文案)' };
  if (script.length > 2000)
    return { ok: false, status: 400, error: '文案超过 2000 字上限', extra: { length: script.length } };
  if (!isUsableAvatar(avatarRef, tid))
    return { ok: false, status: 400, error: '形象不可用(不存在或非本机构)' };
  if (!isUsableVoice(voiceRef, tid))
    return { ok: false, status: 400, error: '音色不可用(不存在或非本机构)' };
  if (speed !== undefined && (typeof speed !== 'number' || speed < 0.5 || speed > 2))
    return { ok: false, status: 400, error: '语速需在 0.5–2 倍之间' };
  if (volume !== undefined && (typeof volume !== 'number' || volume < 0 || volume > 100))
    return { ok: false, status: 400, error: '音量需在 0–100 之间' };

  const input: VideoGenInput = { avatarRef, voiceRef, script };
  if (resolution) input.resolution = resolution;
  if (ratio) input.ratio = ratio;
  if (speed !== undefined) input.speed = speed;
  if (volume !== undefined) input.volume = volume;
  return {
    ok: true,
    type: 'video',
    input: input as unknown as Record<string, unknown>,
    cost: estimateCost(script.length, resolution),
  };
}

/** 校验并构建 ai_image(AI 图片,文生图)job 入参 + 计价。 */
function buildImageJob(body: Record<string, unknown>): JobBuildResult {
  const { prompt, count, resolution, ratio } = body as Partial<ImageGenInput>;
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0)
    return { ok: false, status: 400, error: '缺少 prompt(提示词)' };
  const n = clampImageCount(count); // [1,4],保证 reserve==settle
  const input: ImageGenInput = { prompt, count: n };
  if (typeof resolution === 'string') input.resolution = resolution;
  if (typeof ratio === 'string') input.ratio = ratio;
  return {
    ok: true,
    type: 'ai_image',
    input: input as unknown as Record<string, unknown>,
    cost: estimateImageCost(n, typeof resolution === 'string' ? resolution : undefined),
  };
}

// 封闭 allowlist:type → builder。Object.create(null) 防原型链污染(type='__proto__' 取不到)。
const JOB_BUILDERS: Record<string, (body: Record<string, unknown>, tid: string) => JobBuildResult> =
  Object.assign(Object.create(null), {
    video: buildVideoJob,
    ai_image: (body: Record<string, unknown>) => buildImageJob(body),
  });

// 提交生成 — 仅 admin/creator(viewer 不能发起生成,验收第8条)
jobsRouter.post('/jobs', requireRole('admin', 'creator'), (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const tid = req.user!.tenantId;

  // type 默认 video(兼容现有数字人前端不传 type 的请求);封闭 allowlist。
  const type = typeof body.type === 'string' && body.type ? body.type : 'video';
  const builder = Object.prototype.hasOwnProperty.call(JOB_BUILDERS, type)
    ? JOB_BUILDERS[type]
    : undefined;
  if (!builder) {
    return res.status(400).json({ error: `不支持的任务类型:${type}` });
  }

  const built = builder(body, tid);
  if (!built.ok) {
    return res.status(built.status).json({ error: built.error, ...(built.extra ?? {}) });
  }

  // 先入队拿 jobId,再按预估 reserve(reserve 关联 jobId,失败时能精确 release)
  const { cost } = built;
  if (balance(tid) < cost) {
    return res.status(402).json({ error: '积分余额不足', need: cost, balance: balance(tid) });
  }
  const id = enqueueJob(built.type, built.input, tid);
  try {
    reserve(tid, id, cost); // 原子:再次校验余额 + 预扣
  } catch (e) {
    return res.status(402).json({ error: e instanceof Error ? e.message : '预扣失败' });
  }
  audit(req, 'create_job', id);
  return res.status(202).json({ id, status: 'queued', cost });
});

// 费用预估(生成前展示,验收第4条)。按 type 计价;默认 video。
jobsRouter.post('/jobs/estimate', requireAuth, (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const type = typeof body.type === 'string' && body.type ? body.type : 'video';
  if (type === 'ai_image') {
    return res.json({
      cost: estimateImageCost(
        clampImageCount(body.count),
        typeof body.resolution === 'string' ? body.resolution : undefined,
      ),
    });
  }
  if (typeof body.script !== 'string') return res.status(400).json({ error: '缺少 script' });
  return res.json({
    cost: estimateCost(body.script.length, typeof body.resolution === 'string' ? body.resolution : undefined),
  });
});

// 作品列表 — 任何登录角色(含 viewer)可读本租户作品
jobsRouter.get('/jobs', requireAuth, async (req: Request, res: Response) => {
  const rows = listJobsForTenant(req.user!.tenantId);
  const jobs = await Promise.all(
    rows.map(async (j) => {
      // 成品签名 URL:支持多产物(图片多图)。向后兼容旧视频裸 key(signOutputUrls 内处理)。
      const outputUrls =
        j.status === 'done' && j.output_url ? await signOutputUrls(j.output_url) : [];
      // 文案/提示词:供卡片标题。video 取 script,ai_image 取 prompt;解析失败给空串不崩。
      let script = '';
      try {
        const inp = JSON.parse(j.input_json) as { script?: string; prompt?: string };
        script = inp.script ?? inp.prompt ?? '';
      } catch {
        /* 旧/坏数据忽略 */
      }
      return {
        id: j.id,
        status: j.status,
        progress: j.progress,
        type: j.type,
        outputKind: j.output_kind,
        error: j.error,
        videoUrl: outputUrls[0] ?? null, // 兼容旧前端字段(单产物首个)
        outputUrls, // 多产物全量(图片多图)
        script,
        createdAt: j.created_at,
      };
    }),
  );
  return res.json(jobs);
});

// 状态快照(前端轮询)— 任何登录角色可读,但只能读本租户的
jobsRouter.get('/jobs/:id', requireAuth, async (req: Request, res: Response) => {
  const job = getJobForTenant(req.params.id!, req.user!.tenantId);
  if (!job) return res.status(404).json({ error: '任务不存在' });

  const payload: Record<string, unknown> = {
    id: job.id,
    status: job.status,
    progress: job.progress,
    type: job.type,
    outputKind: job.output_kind,
    aiLabel: job.ai_label,
    error: job.error,
    createdAt: job.created_at,
    input: JSON.parse(job.input_json), // 供"重新编辑"回填原入参(T5)
  };

  if (job.status === 'done' && job.output_url) {
    const outputUrls = await signOutputUrls(job.output_url);
    payload.outputUrls = outputUrls; // 多产物(图片多图)
    payload.videoUrl = outputUrls[0] ?? null; // 兼容旧前端字段
    if (outputUrls.length === 0) payload.warn = '成品已生成但签名 URL 暂不可用';
  }

  return res.json(payload);
});

// 失败重试 — 仅 admin/creator,且只能重试本租户的
jobsRouter.post('/jobs/:id/retry', requireRole('admin', 'creator'), (req: Request, res: Response) => {
  const ok = retryJob(req.params.id!, req.user!.tenantId);
  if (!ok) return res.status(409).json({ error: '任务不存在、非本机构、或非 failed 状态' });
  return res.json({ id: req.params.id, status: 'queued' });
});

// 删除作品 — 仅 admin/creator,租户隔离,生成中不可删
jobsRouter.delete('/jobs/:id', requireRole('admin', 'creator'), (req: Request, res: Response) => {
  const ok = deleteJobForTenant(req.params.id!, req.user!.tenantId);
  if (!ok) return res.status(409).json({ error: '任务不存在、非本机构、或生成中不可删' });
  return res.json({ ok: true });
});
