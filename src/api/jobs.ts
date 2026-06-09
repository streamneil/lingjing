// 灵镜 API — 任务路由(Slice 2:接入鉴权 + 租户隔离)。
//
// 决策来源:/plan-eng-review D4(DB 真相 + 轮询)+ 验收第8条(viewer 不能发起生成)。
// 所有读写经 tenant-scoped 查询,杜绝跨租户串数据。

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import {
  enqueueJob,
  getJobForTenant,
  listJobsForTenant,
  retryJob,
  deleteJobForTenant,
} from '../queue/index.js';
import { signOutputUrls, putObject } from '../storage/index.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import {
  estimateCost,
  estimateImageCost,
  estimateImageEditCost,
  estimateTtsCost,
  clampImageCount,
  reserve,
  balance,
} from '../credits/index.js';
import { audit } from '../audit/index.js';
import { isUsableAvatar } from '../avatars/index.js';
import { isUsableVoice } from '../voices/index.js';
import { db } from '../db/index.js';
import type { VideoGenInput, ImageGenInput, TtsGenInput } from '../gateway/types.js';
import { IMAGE_MODELS, getImageModel, resolutionAllowed } from '../gateway/image-models.js';

export const jobsRouter = Router();

// 图生图输入图上传:multer 内存缓冲,≤30MB,最多 3 张(qwen-image-edit 上限)。
const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

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

/** 校验并构建 ai_image job 入参 + 计价。多模型(registry)+ (model,mode) 校验。
 *
 * 顺序(eng 外部声音 P1-d,保 reserve==settle):
 *   resolve model(默认兜底)→ 校验 mode/4K/张数 → clamp(maxImages)→ 写 input.count+model → cost(读 priceTier)。
 */
function buildImageJob(body: Record<string, unknown>): JobBuildResult {
  const { model, prompt, count, resolution, ratio, mode, imageRefs } = body as Partial<ImageGenInput>;
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0)
    return { ok: false, status: 400, error: '缺少 prompt(提示词)' };
  const res = typeof resolution === 'string' ? resolution : undefined;

  // 1. resolve model:显式传的必须在白名单;缺省按 mode 走默认(C5b 老 job/前端未传兼容)。
  if (model !== undefined && (typeof model !== 'string' || !IMAGE_MODELS[model]))
    return { ok: false, status: 400, error: '模型不可用' };
  const effMode: 'text2img' | 'img2img' = mode === 'img2img' ? 'img2img' : 'text2img';
  const def = getImageModel(model, effMode);
  // 2. model × mode 兼容
  if (!def.modes.includes(effMode))
    return { ok: false, status: 400, error: `该模型不支持${effMode === 'img2img' ? '图生图' : '文生图'}` };
  // 3. 分辨率上限(4K 不支持 → 400,非 clamp:P2-4k 防按 4K 价扣却出 ≤2K)
  if (!resolutionAllowed(def, res))
    return { ok: false, status: 400, error: `该模型最高支持 ${def.maxResolution}` };

  if (effMode === 'img2img') {
    const refs = Array.isArray(imageRefs) ? imageRefs.filter((k) => typeof k === 'string') : [];
    if (refs.length === 0) return { ok: false, status: 400, error: '图生图需上传至少 1 张输入图' };
    if (refs.length > def.maxInputImages)
      return { ok: false, status: 400, error: `该模型最多 ${def.maxInputImages} 张输入图` };
    const input: ImageGenInput = { model: def.key, mode: 'img2img', prompt, imageRefs: refs };
    if (res) input.resolution = res;
    if (typeof ratio === 'string') input.ratio = ratio;
    return {
      ok: true,
      type: 'ai_image',
      input: input as unknown as Record<string, unknown>,
      cost: estimateImageEditCost(res, def.priceTier),
    };
  }

  // 文生图:clamp 按 model maxImages 并回写 input.count(reserve==settle)
  const n = clampImageCount(count, def.maxImages);
  const input: ImageGenInput = { model: def.key, mode: 'text2img', prompt, count: n };
  if (res) input.resolution = res;
  if (typeof ratio === 'string') input.ratio = ratio;
  return {
    ok: true,
    type: 'ai_image',
    input: input as unknown as Record<string, unknown>,
    cost: estimateImageCost(n, res, def.priceTier, def.maxImages),
  };
}

/** 校验并构建 tts(文转语音)job 入参 + 计价。 */
function buildTtsJob(body: Record<string, unknown>, tid: string): JobBuildResult {
  const { text, voiceRef, rate, volume } = body as Partial<TtsGenInput>;
  if (!text || typeof text !== 'string' || text.trim().length === 0)
    return { ok: false, status: 400, error: '缺少 text(配音文本)' };
  if (!voiceRef || typeof voiceRef !== 'string')
    return { ok: false, status: 400, error: '缺少 voiceRef(音色)' };
  if (!isUsableVoice(voiceRef, tid))
    return { ok: false, status: 400, error: '音色不可用(不存在或非本机构)' };
  if (rate !== undefined && (typeof rate !== 'number' || rate < 0.5 || rate > 2))
    return { ok: false, status: 400, error: '语速需在 0.5–2 倍之间' };
  if (volume !== undefined && (typeof volume !== 'number' || volume < 0 || volume > 100))
    return { ok: false, status: 400, error: '音量需在 0–100 之间' };

  const input: TtsGenInput = { text, voiceRef };
  if (rate !== undefined) input.rate = rate;
  if (volume !== undefined) input.volume = volume;
  return {
    ok: true,
    type: 'tts',
    input: input as unknown as Record<string, unknown>,
    cost: estimateTtsCost(text.length),
  };
}

// 封闭 allowlist:type → builder。Object.create(null) 防原型链污染(type='__proto__' 取不到)。
const JOB_BUILDERS: Record<string, (body: Record<string, unknown>, tid: string) => JobBuildResult> =
  Object.assign(Object.create(null), {
    video: buildVideoJob,
    ai_image: (body: Record<string, unknown>) => buildImageJob(body),
    tts: buildTtsJob,
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

// ── 图生图输入图上传 ──
// 仅 admin/creator。授权门票(/plan-ceo-review B4 + 外部声音 P1):含人输入图编辑=深度合成真人,
// 必须 consent + proof,与形象上传同等合规——绝不弱化护城河。
// images[] 1-3 张,落 MinIO 存 key,每张写 authorization 行(subject_type='image-edit'),返回 key 数组。
jobsRouter.post(
  '/image-uploads',
  requireRole('admin', 'creator'),
  imageUpload.fields([
    { name: 'images', maxCount: 3 },
    { name: 'proof', maxCount: 1 },
  ]),
  async (req: Request, res: Response) => {
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const images = files?.images ?? [];
    const proof = files?.proof?.[0];
    const consent = req.body?.consent === 'true' || req.body?.consent === true;
    const tid = req.user!.tenantId;

    if (images.length === 0) return res.status(400).json({ error: '缺少图片(images)' });
    if (images.length > 3) return res.status(400).json({ error: '最多 3 张输入图' });
    for (const img of images) {
      if (!img.mimetype.startsWith('image/'))
        return res.status(400).json({ error: '仅支持图片文件' });
    }
    // 授权门票:含人输入图必须授权(同形象上传)
    if (!consent) {
      return res.status(400).json({ error: '必须勾选"已获图中人物授权"(政企合规)' });
    }

    try {
      // 授权凭证(可选上传):落 MinIO
      let proofKey: string | undefined;
      if (proof) {
        const pext = (proof.originalname.split('.').pop() || 'bin').toLowerCase();
        proofKey = `authorizations/${tid}/${randomUUID()}.${pext}`;
        await putObject(proofKey, proof.buffer, proof.mimetype);
      }
      const keys: string[] = [];
      for (const img of images) {
        const ext = (img.originalname.split('.').pop() || 'png').toLowerCase();
        const key = `image-inputs/${tid}/${randomUUID()}.${ext}`;
        await putObject(key, img.buffer, img.mimetype);
        // 每张输入图写授权存证行(subject_type='image-edit',可举证同意的条款版本)
        db.prepare(
          `INSERT INTO authorization (id,tenant_id,subject_type,consent,proof_key,terms_version,created_by,created_at)
           VALUES (?,?,?,?,?,?,?,?)`,
        ).run(randomUUID(), tid, 'image-edit', 1, proofKey ?? null, 'v1', req.user!.id, Date.now());
        keys.push(key);
      }
      audit(req, 'upload_image_input', keys[0]!);
      return res.status(201).json({ imageRefs: keys });
    } catch (e) {
      return res.status(500).json({ error: e instanceof Error ? e.message : '上传失败' });
    }
  },
);

// 费用预估(生成前展示,验收第4条)。按 type 计价;默认 video。
jobsRouter.post('/jobs/estimate', requireAuth, (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const type = typeof body.type === 'string' && body.type ? body.type : 'video';
  if (type === 'ai_image') {
    const res2 = typeof body.resolution === 'string' ? body.resolution : undefined;
    const m = body.mode === 'img2img' ? 'img2img' : 'text2img';
    const def = getImageModel(typeof body.model === 'string' ? body.model : undefined, m);
    if (m === 'img2img') return res.json({ cost: estimateImageEditCost(res2, def.priceTier) });
    return res.json({
      cost: estimateImageCost(clampImageCount(body.count, def.maxImages), res2, def.priceTier, def.maxImages),
    });
  }
  if (type === 'tts') {
    return res.json({ cost: estimateTtsCost(typeof body.text === 'string' ? body.text.length : 0) });
  }
  if (typeof body.script !== 'string') return res.status(400).json({ error: '缺少 script' });
  return res.json({
    cost: estimateCost(body.script.length, typeof body.resolution === 'string' ? body.resolution : undefined),
  });
});

// 图像模型清单 — 前端下拉的单一真相源(P2-b:requireAuth,同级路由一致)。
// 吐 registry 的 UI 相关字段(不泄漏内部 modelId/priceTier 计费细节)。
jobsRouter.get('/image-models', requireAuth, (_req: Request, res: Response) => {
  const models = Object.values(IMAGE_MODELS).map((d) => ({
    key: d.key,
    label: d.label,
    modes: d.modes,
    maxImages: d.maxImages,
    maxInputImages: d.maxInputImages,
    maxResolution: d.maxResolution,
  }));
  res.json({ models, default: 'qwen-image' });
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
        const inp = JSON.parse(j.input_json) as { script?: string; prompt?: string; text?: string };
        script = inp.script ?? inp.prompt ?? inp.text ?? '';
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
