// 灵镜 API — 任务路由(Slice 2:接入鉴权 + 租户隔离)。
//
// 决策来源:/plan-eng-review D4(DB 真相 + 轮询)+ 验收第8条(viewer 不能发起生成)。
// 所有读写经 tenant-scoped 查询,杜绝跨租户串数据。

import { Router, type Request, type Response } from 'express';
import {
  enqueueVideo,
  getJobForTenant,
  listJobsForTenant,
  retryJob,
  deleteJobForTenant,
} from '../queue/index.js';
import { getSignedUrl } from '../storage/index.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { estimateCost, reserve, balance } from '../credits/index.js';
import { audit } from '../audit/index.js';
import { isUsableAvatar } from '../avatars/index.js';
import { isUsableVoice } from '../voices/index.js';
import type { VideoGenInput } from '../gateway/types.js';

export const jobsRouter = Router();

// 提交生成 — 仅 admin/creator(viewer 不能发起生成,验收第8条)
jobsRouter.post('/jobs', requireRole('admin', 'creator'), (req: Request, res: Response) => {
  const body = req.body ?? {};
  const { avatarRef, voiceRef, script, resolution, ratio, speed, volume } = body as Partial<VideoGenInput>;

  if (!avatarRef || typeof avatarRef !== 'string') {
    return res.status(400).json({ error: '缺少 avatarRef(形象)' });
  }
  if (!voiceRef || typeof voiceRef !== 'string') {
    return res.status(400).json({ error: '缺少 voiceRef(音色)' });
  }
  if (!script || typeof script !== 'string' || script.trim().length === 0) {
    return res.status(400).json({ error: '缺少 script(文案)' });
  }
  if (script.length > 2000) {
    return res.status(400).json({ error: '文案超过 2000 字上限', length: script.length });
  }
  // 校验形象/音色对本租户可用(预置 or 本租户 ready),防止用别家或不存在的资源
  const tid = req.user!.tenantId;
  if (!isUsableAvatar(avatarRef, tid)) {
    return res.status(400).json({ error: '形象不可用(不存在或非本机构)' });
  }
  if (!isUsableVoice(voiceRef, tid)) {
    return res.status(400).json({ error: '音色不可用(不存在或非本机构)' });
  }

  // 语速/音量范围校验(PRD E4):超出百炼合法区间直接 400,不透传给百炼(D5)
  if (speed !== undefined && (typeof speed !== 'number' || speed < 0.5 || speed > 2)) {
    return res.status(400).json({ error: '语速需在 0.5–2 倍之间' });
  }
  if (volume !== undefined && (typeof volume !== 'number' || volume < 0 || volume > 100)) {
    return res.status(400).json({ error: '音量需在 0–100 之间' });
  }

  const input: VideoGenInput = { avatarRef, voiceRef, script };
  if (resolution) input.resolution = resolution;
  if (ratio) input.ratio = ratio;
  if (speed !== undefined) input.speed = speed;
  if (volume !== undefined) input.volume = volume;

  // 先入队拿 jobId,再按预估 reserve(reserve 关联 jobId,失败时能精确 release)
  const cost = estimateCost(script.length, resolution);
  if (balance(tid) < cost) {
    return res.status(402).json({ error: '积分余额不足', need: cost, balance: balance(tid) });
  }
  const id = enqueueVideo(input, tid);
  try {
    reserve(tid, id, cost); // 原子:再次校验余额 + 预扣
  } catch (e) {
    // 极端并发下二次校验失败:把刚入队的任务标失败,不留悬挂任务
    return res.status(402).json({ error: e instanceof Error ? e.message : '预扣失败' });
  }
  audit(req, 'create_job', id);
  return res.status(202).json({ id, status: 'queued', cost });
});

// 费用预估(生成前展示,验收第4条)
jobsRouter.post('/jobs/estimate', requireAuth, (req: Request, res: Response) => {
  const { script, resolution } = req.body ?? {};
  if (typeof script !== 'string') return res.status(400).json({ error: '缺少 script' });
  return res.json({ cost: estimateCost(script.length, resolution) });
});

// 作品列表 — 任何登录角色(含 viewer)可读本租户作品
jobsRouter.get('/jobs', requireAuth, (req: Request, res: Response) => {
  const jobs = listJobsForTenant(req.user!.tenantId).map((j) => ({
    id: j.id,
    status: j.status,
    progress: j.progress,
    type: j.type,
    error: j.error,
    createdAt: j.created_at,
  }));
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
    aiLabel: job.ai_label,
    error: job.error,
    createdAt: job.created_at,
    input: JSON.parse(job.input_json), // 供"重新编辑"回填原文案/形象/音色/参数(T5)
  };

  if (job.status === 'done' && job.output_url) {
    try {
      payload.videoUrl = await getSignedUrl(job.output_url);
    } catch {
      payload.videoUrl = null;
      payload.warn = '成品已生成但签名 URL 暂不可用';
    }
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
