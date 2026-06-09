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
import { signOutputUrls, getSignedUrl, putObject } from '../storage/index.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import {
  estimateCost,
  estimateImageCost,
  estimateImageEditCost,
  estimateTtsCost,
  estimateVideoCost,
  clampImageCount,
  reserve,
  balance,
} from '../credits/index.js';
import { audit } from '../audit/index.js';
import { isUsableAvatar } from '../avatars/index.js';
import { isUsableVoice } from '../voices/index.js';
import { db } from '../db/index.js';
import type { VideoGenInput, ImageGenInput, TtsGenInput, VideoGenT2VInput } from '../gateway/types.js';
import { getImageModel, resolutionAllowed, isKnownModel, listEnabledModels, DEFAULT_IMAGE_MODEL, tierFromPixels } from '../gateway/image-models.js';
import { getVideoModel, isKnownVideoModel, listVideoModels, klingModeToResolution } from '../gateway/video-models.js';

export const jobsRouter = Router();

// 图生图输入图上传:multer 内存缓冲,≤30MB,最多 5 张(万相2.7 上限;千问编辑 3 张按 model maxInputImages 在 buildImageJob 校验)。
const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

// 输入图存储 key → 签名 URL(供记录卡显示 + 重新提示回填)。逐 key 签名,坏 key 跳过不整体 500。
async function signInputUrls(refs?: string[]): Promise<string[]> {
  if (!Array.isArray(refs) || !refs.length) return [];
  const signed = await Promise.all(refs.map((k) => getSignedUrl(k).catch(() => null)));
  return signed.filter((u): u is string => u !== null);
}

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

/** 校验 bbox_list(局部重绘框选):长度须 = 输入图数;每图 ≤2 框;每框 [x1,y1,x2,y2] 整数且 0≤x1<x2、0≤y1<y2。
 *  空框图保留 []（保持与图对齐,绝不丢弃 → 否则厂商 reserve 后才报错卡积分,P3-bbox)。
 *  返回 boxes:全空(每图都 [])时返回 []，调用方据此决定不传 bbox_list。 */
export function validateBboxList(raw: unknown, refCount: number): { ok: true; boxes: number[][][] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: 'bbox 格式错误(应为数组)' };
  if (raw.length !== refCount) return { ok: false, error: `bbox 数量(${raw.length})须与输入图数(${refCount})一致` };
  const boxes: number[][][] = [];
  let anyBox = false;
  for (const perImg of raw) {
    if (!Array.isArray(perImg)) return { ok: false, error: 'bbox 每图应为框数组' };
    if (perImg.length > 2) return { ok: false, error: '每张图最多 2 个框选区域' };
    const rects: number[][] = [];
    for (const rect of perImg) {
      if (!Array.isArray(rect) || rect.length !== 4) return { ok: false, error: 'bbox 每框须为 [x1,y1,x2,y2]' };
      const [x1, y1, x2, y2] = rect.map((n) => Number(n));
      if (![x1, y1, x2, y2].every((n) => Number.isInteger(n)))
        return { ok: false, error: 'bbox 坐标须为整数' };
      if (!(x1! >= 0 && y1! >= 0 && x2! > x1! && y2! > y1!))
        return { ok: false, error: 'bbox 坐标须满足 0≤x1<x2、0≤y1<y2' };
      rects.push([x1!, y1!, x2!, y2!]);
      anyBox = true;
    }
    boxes.push(rects);
  }
  return { ok: true, boxes: anyBox ? boxes : [] };
}

/** 校验并构建 ai_image job 入参 + 计价。多模型(registry)+ (model,mode) 校验。
 *
 * 顺序(eng 外部声音 P1-d,保 reserve==settle):
 *   resolve model(默认兜底)→ 校验 mode/4K/张数 → clamp(maxImages)→ 写 input.count+model → cost(读 priceTier)。
 */
function buildImageJob(body: Record<string, unknown>): JobBuildResult {
  const { model, prompt, count, resolution, ratio, mode, imageRefs, seed } = body as Partial<ImageGenInput>;
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0)
    return { ok: false, status: 400, error: '缺少 prompt(提示词)' };
  const res = typeof resolution === 'string' ? resolution : undefined;
  // 来源页(记录归属):前端传 'ai-image' | 'ai-image-edit';未传/非法 → undefined(老 job)。
  // 记录列表按来源页分流(用户在哪页提交就归哪页),与生成模式 mode 无关。
  const rawSource = (body as { source?: unknown }).source;
  const source = (rawSource === 'ai-image' || rawSource === 'ai-image-edit') ? rawSource : undefined;

  // seed 校验(A4):未传/空 ok(随机);传了必须是 [0,2147483647] 整数。
  let seedVal: number | undefined;
  if (seed !== undefined && seed !== null && (seed as unknown) !== '') {
    const s = Number(seed);
    if (!Number.isInteger(s) || s < 0 || s > 2147483647)
      return { ok: false, status: 400, error: 'seed 需为 0–2147483647 的整数' };
    seedVal = s;
  }

  // 1. resolve model:显式传的必须在 registry(代码或 DB);缺省按 mode 走默认。
  if (model !== undefined && (typeof model !== 'string' || !isKnownModel(model)))
    return { ok: false, status: 400, error: '模型不可用' };
  const effMode: 'text2img' | 'img2img' = mode === 'img2img' ? 'img2img' : 'text2img';
  const def = getImageModel(model, effMode);
  // 2. model × mode 兼容
  if (!def.modes.includes(effMode))
    return { ok: false, status: 400, error: `该模型不支持${effMode === 'img2img' ? '图生图' : '文生图'}` };

  // 3. 分辨率:有 resolutions 表 → 按所选 ratio 查表得 W×H + 自动推 tier(钱不塌,P1-a/c);
  //    无表 → 回落旧逻辑(res + resolutionAllowed 4K 守卫,P1-b)。
  let effRes = res; // 计价档(tier);有表则覆盖为自动推的
  let sizeSnap: { width?: number; height?: number } = {};
  if (def.resolutions?.length) {
    const wantRatio = typeof ratio === 'string' ? ratio : (def.resolutions.find((r) => r.isDefault)?.ratio ?? def.resolutions[0]!.ratio);
    const hit = def.resolutions.find((r) => r.ratio === wantRatio);
    if (!hit) return { ok: false, status: 400, error: `该模型不支持比例 ${wantRatio}` }; // P2-a:不信前端
    sizeSnap = { width: hit.width, height: hit.height };
    effRes = tierFromPixels(hit.width, hit.height); // 计价档从像素自动推
  } else {
    // 无表:旧 4K 守卫(P1-b 保留)
    if (!resolutionAllowed(def, res))
      return { ok: false, status: 400, error: `该模型最高支持 ${def.maxResolution}` };
  }

  // 提交时快照(P3 + P1-c):priceTier/maxImages + 所选分辨率 W×H,worker settle/生成读快照,
  // admin mid-flight 改价/改分辨率不破 reserve==settle、不改在飞 job 尺寸。
  const snap = { priceTierSnapshot: def.priceTier, maxImagesSnapshot: def.maxImages, ...sizeSnap };

  if (effMode === 'img2img') {
    const isAsyncEdit = def.shape === 'A_EDIT'; // 万相2.7:异步、可 0 图、可 bbox、可多出图
    const refs = Array.isArray(imageRefs) ? imageRefs.filter((k) => typeof k === 'string') : [];
    // 千问编辑必须 ≥1 张;万相2.7 允许 0 张(纯生成 / 文本编辑)。
    if (!isAsyncEdit && refs.length === 0)
      return { ok: false, status: 400, error: '图生图需上传至少 1 张输入图' };
    if (refs.length > def.maxInputImages)
      return { ok: false, status: 400, error: `该模型最多 ${def.maxInputImages} 张输入图` };

    const input: ImageGenInput = { model: def.key, mode: 'img2img', prompt, imageRefs: refs, ...snap };
    if (source) input.source = source;
    if (effRes) input.resolution = effRes; // 计价档(自动推或用户传)
    if (typeof ratio === 'string') input.ratio = ratio;
    if (seedVal !== undefined) input.seed = seedVal;

    // bbox_list 局部重绘:仅 supportsBbox 模型(万相2.7);校验对齐 + 框数 + 整数边界(不信前端,P2-a)。
    const rawBbox = (body as { bboxList?: unknown }).bboxList;
    if (rawBbox !== undefined && rawBbox !== null) {
      if (!def.supportsBbox) return { ok: false, status: 400, error: '该模型不支持局部重绘(bbox)' };
      const v = validateBboxList(rawBbox, refs.length);
      if (!v.ok) return { ok: false, status: 400, error: v.error };
      if (v.boxes.length) input.bboxList = v.boxes; // 全空则不传
    }

    // 多出图编辑(maxImages>1:万相2.7 A_EDIT、千问2.0 Pro 同步)按 n 张计价 + 快照 count
    // (reserve==settle);qwen-image-edit maxImages=1 → clamp 自然固定 1 张,逻辑统一。
    const editCount = clampImageCount(count, def.maxImages);
    input.count = editCount; // 始终写 count,worker 据此传 n 给 editImage/submitImageEdit
    return {
      ok: true,
      type: 'ai_image',
      input: input as unknown as Record<string, unknown>,
      cost: estimateImageEditCost(effRes, def.priceTier, editCount),
    };
  }

  // 文生图:clamp 按 model maxImages 并回写 input.count(reserve==settle)
  const n = clampImageCount(count, def.maxImages);
  const input: ImageGenInput = { model: def.key, mode: 'text2img', prompt, count: n, ...snap };
  if (source) input.source = source;
  if (effRes) input.resolution = effRes;
  if (typeof ratio === 'string') input.ratio = ratio;
  if (seedVal !== undefined) input.seed = seedVal;
  return {
    ok: true,
    type: 'ai_image',
    input: input as unknown as Record<string, unknown>,
    cost: estimateImageCost(n, effRes, def.priceTier, def.maxImages),
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

/** 文生视频参数派生(eng-review N2:build 与 /jobs/estimate 共用同一份规则,保 reserve==settle)。
 *  从原始 body 派生出计价/快照所需的 {duration, resolution档, audio, priceTier}。
 *  - duration:clamp 到 model durationRange。
 *  - resolution 档:可灵由 mode 翻译(std→720P、pro→1080P,R3);V_DASH 用 body.resolution。
 *  - audio:仅 supportsAudio 模型生效(R6);其余恒 false。 */
function deriveVideoT2VParams(def: ReturnType<typeof getVideoModel>, body: Record<string, unknown>): {
  duration: number; resolution: string; audio: boolean; priceTier: number;
} {
  const [dmin, dmax] = def.durationRange;
  const rawDur = typeof body.duration === 'number' && Number.isFinite(body.duration)
    ? Math.floor(body.duration) : def.defaultDuration;
  const duration = Math.min(dmax, Math.max(dmin, rawDur));
  const resolution = def.shape === 'V_KLING'
    ? klingModeToResolution(typeof body.mode === 'string' ? body.mode : undefined)
    : (typeof body.resolution === 'string' ? body.resolution : '720P');
  const audio = def.supportsAudio ? !!body.audio : false;
  return { duration, resolution, audio, priceTier: def.priceTier };
}

/** 校验并构建 video_t2v(文生视频)job 入参 + 计价。三模型(registry)+ shape 感知校验。 */
function buildVideoT2VJob(body: Record<string, unknown>): JobBuildResult {
  const modelKey = typeof body.model === 'string' ? body.model : undefined;
  if (modelKey && !isKnownVideoModel(modelKey))
    return { ok: false, status: 400, error: '未知视频模型' };
  const def = getVideoModel(modelKey);

  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  if (!prompt.trim()) return { ok: false, status: 400, error: '缺少 prompt(视频描述)' };
  if (prompt.length > def.maxPromptChars)
    return { ok: false, status: 400, error: `提示词超过 ${def.maxPromptChars} 字上限`, extra: { length: prompt.length } };

  // 比例校验(在模型允许集)
  const ratio = typeof body.ratio === 'string' ? body.ratio : def.ratios[0]!;
  if (!def.ratios.includes(ratio)) return { ok: false, status: 400, error: '该模型不支持所选比例' };

  // shape 相关校验
  if (def.shape === 'V_KLING') {
    const mode = typeof body.mode === 'string' ? body.mode : 'std';
    if (mode !== 'std' && mode !== 'pro') return { ok: false, status: 400, error: 'mode 仅支持 std / pro' };
  } else {
    const resolution = typeof body.resolution === 'string' ? body.resolution : '720P';
    if (!def.resolutions.includes(resolution as '720P' | '1080P'))
      return { ok: false, status: 400, error: '该模型不支持所选分辨率' };
  }
  // audio 仅 supportsAudio 模型可开(R5:happyhorse/wan2.7 开音频 → 400,不静默吞)
  if (body.audio === true && !def.supportsAudio)
    return { ok: false, status: 400, error: '该模型不支持有声视频' };
  // duration 范围校验(超界 400,不静默 clamp 让用户以为生效)
  if (body.duration !== undefined) {
    const d = body.duration;
    const [dmin, dmax] = def.durationRange;
    if (typeof d !== 'number' || !Number.isInteger(d) || d < dmin || d > dmax)
      return { ok: false, status: 400, error: `时长需为 ${dmin}–${dmax} 秒之间的整数` };
  }
  if (body.seed !== undefined && (typeof body.seed !== 'number' || body.seed < 0 || body.seed > 2147483647))
    return { ok: false, status: 400, error: 'seed 需在 0–2147483647 之间' };

  const { duration, resolution, audio, priceTier } = deriveVideoT2VParams(def, body);

  const input: VideoGenT2VInput = { model: def.key, prompt, ratio };
  if (def.shape === 'V_KLING') {
    input.mode = (typeof body.mode === 'string' && body.mode === 'pro') ? 'pro' : 'std';
    if (audio) input.audio = true;
  } else {
    input.resolution = resolution;
    if (def.supportsNegative && typeof body.negativePrompt === 'string' && body.negativePrompt.trim())
      input.negativePrompt = body.negativePrompt;
    if (def.supportsPromptExtend && typeof body.promptExtend === 'boolean')
      input.promptExtend = body.promptExtend;
  }
  input.duration = duration;
  if (typeof body.seed === 'number') input.seed = body.seed;
  // 快照(reserve==settle):duration/res档/audio/priceTier 提交时定死。
  input.durationSnapshot = duration;
  input.resSnapshot = resolution;
  input.audioSnapshot = audio;
  input.priceTierSnapshot = priceTier;

  return {
    ok: true,
    type: 'video_t2v',
    input: input as unknown as Record<string, unknown>,
    cost: estimateVideoCost(duration, priceTier, resolution, audio),
  };
}

// 封闭 allowlist:type → builder。Object.create(null) 防原型链污染(type='__proto__' 取不到)。
const JOB_BUILDERS: Record<string, (body: Record<string, unknown>, tid: string) => JobBuildResult> =
  Object.assign(Object.create(null), {
    video: buildVideoJob,
    ai_image: (body: Record<string, unknown>) => buildImageJob(body),
    video_t2v: (body: Record<string, unknown>) => buildVideoT2VJob(body),
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
    { name: 'images', maxCount: 5 },
    { name: 'proof', maxCount: 1 },
  ]),
  async (req: Request, res: Response) => {
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const images = files?.images ?? [];
    const proof = files?.proof?.[0];
    const consent = req.body?.consent === 'true' || req.body?.consent === true;
    const tid = req.user!.tenantId;

    if (images.length === 0) return res.status(400).json({ error: '缺少图片(images)' });
    if (images.length > 5) return res.status(400).json({ error: '最多 5 张输入图' });
    // 防御纵深:前端已拦 HEIC/非支持格式/超 10MB,但客户端可绕过 → 后端再校验一遍。
    // 百炼图生图支持(qwen-image-edit 文档):JPEG/PNG/WEBP/BMP/TIFF/GIF;不含 HEIC。
    const OK_IMG = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/bmp', 'image/tiff', 'image/gif']);
    for (const img of images) {
      if (/heic|heif/i.test(img.mimetype) || /\.heic$|\.heif$/i.test(img.originalname))
        return res.status(400).json({ error: '暂不支持 HEIC,请上传 JPG/PNG/WEBP' });
      if (!OK_IMG.has(img.mimetype))
        return res.status(400).json({ error: `不支持的格式 ${img.mimetype || '未知'},请用 JPG/PNG/WEBP` });
      if (img.size > 10 * 1024 * 1024)
        return res.status(400).json({ error: '单张图片不能超过 10MB' });
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
    const m = body.mode === 'img2img' ? 'img2img' : 'text2img';
    const def = getImageModel(typeof body.model === 'string' ? body.model : undefined, m);
    // 有 resolutions 表 → 按所选 ratio 查表自动推 tier(与 buildImageJob 一致,计价不塌 P1-a/P3-a);
    // 无表 → 用 body.resolution。
    let res2 = typeof body.resolution === 'string' ? body.resolution : undefined;
    if (def.resolutions?.length) {
      const wantRatio = typeof body.ratio === 'string' ? body.ratio : (def.resolutions.find((r) => r.isDefault)?.ratio ?? def.resolutions[0]!.ratio);
      const hit = def.resolutions.find((r) => r.ratio === wantRatio);
      if (hit) res2 = tierFromPixels(hit.width, hit.height);
    }
    if (m === 'img2img') {
      // 编辑按 n 张计价(与 buildImageJob/costFor 一致):count clamp 到 maxImages
      // (qwen-image-edit maxImages=1 → 固定 1)。
      const editCount = clampImageCount(body.count, def.maxImages);
      return res.json({ cost: estimateImageEditCost(res2, def.priceTier, editCount) });
    }
    return res.json({
      cost: estimateImageCost(clampImageCount(body.count, def.maxImages), res2, def.priceTier, def.maxImages),
    });
  }
  if (type === 'video_t2v') {
    // eng-review N1/N2:与 buildVideoT2VJob 逐字节一致(同 deriveVideoT2VParams + 同 audio 校验)。
    const def = getVideoModel(typeof body.model === 'string' ? body.model : undefined);
    if (body.audio === true && !def.supportsAudio)
      return res.status(400).json({ error: '该模型不支持有声视频' });
    const { duration, resolution, audio, priceTier } = deriveVideoT2VParams(def, body);
    return res.json({ cost: estimateVideoCost(duration, priceTier, resolution, audio) });
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
  // 只列 enabled(DB override 优先);P2-default:default = 首个 enabled(禁用默认时前端不预选不在列表的)。
  const enabled = listEnabledModels();
  const models = enabled.map((d) => ({
    key: d.key,
    label: d.label,
    modes: d.modes,
    maxImages: d.maxImages,
    maxInputImages: d.maxInputImages,
    maxResolution: d.maxResolution,
    supportsBbox: !!d.supportsBbox, // 前端据此显示/隐藏局部重绘画笔(仅万相2.7)
    // admin 录的分辨率表(前端比例下拉用;只吐 ratio/w/h/默认,不漏 priceTier/modelId)
    resolutions: (d.resolutions ?? []).map((r) => ({ ratio: r.ratio, width: r.width, height: r.height, isDefault: !!r.isDefault })),
  }));
  const def = enabled.find((d) => d.key === DEFAULT_IMAGE_MODEL)?.key ?? enabled[0]?.key ?? DEFAULT_IMAGE_MODEL;
  res.json({ models, default: def });
});

// 文生视频模型清单 — 前端下拉单一真相源(只吐 UI 能力字段,不漏 modelId/priceTier)。
jobsRouter.get('/video-models', requireAuth, (_req: Request, res: Response) => {
  const models = listVideoModels().map((d) => ({
    key: d.key,
    label: d.label,
    shape: d.shape, // 前端据此显 mode(V_KLING)或 resolution 段控(V_DASH)
    resolutions: d.resolutions,
    ratios: d.ratios,
    durationRange: d.durationRange,
    defaultDuration: d.defaultDuration,
    maxPromptChars: d.maxPromptChars,
    supportsAudio: d.supportsAudio, // 前端据此显/隐有声开关(仅可灵)
    supportsNegative: d.supportsNegative, // wan2.7
    supportsPromptExtend: d.supportsPromptExtend, // wan2.7
  }));
  res.json({ models, default: getVideoModel().key });
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
      // item4:卡片要显示模型/比例/清晰度 + 重新生成要回放 input → projection 带这些字段(免 N+1)。
      let script = '';
      let meta: Record<string, unknown> = {};
      try {
        const inp = JSON.parse(j.input_json) as {
          script?: string; prompt?: string; text?: string;
          model?: string; mode?: string; source?: string; ratio?: string; resolution?: string; count?: number;
          imageRefs?: string[]; seed?: number; width?: number; height?: number; bboxList?: number[][][];
          duration?: number; audio?: boolean; negativePrompt?: string; promptExtend?: boolean;
        };
        script = inp.script ?? inp.prompt ?? inp.text ?? '';
        if (j.type === 'ai_image') {
          const modelLabel = inp.model ? getImageModel(inp.model, inp.mode === 'img2img' ? 'img2img' : 'text2img').label : undefined;
          // 卡片显示尺寸:有快照 W×H 显「2688×1536」,否则回落 resolution 档(老 job,P2-b)
          const sizeLabel = inp.width && inp.height ? `${inp.width}×${inp.height}` : (inp.resolution || undefined);
          // 输入图签名 URL:供记录卡显示 + 重新提示回填(image-inputs key 同桶,复用 getSignedUrl)。
          const inputUrls = await signInputUrls(inp.imageRefs);
          meta = {
            model: inp.model, modelLabel, mode: inp.mode, source: inp.source, // source:记录归属页
            ratio: inp.ratio, resolution: inp.resolution, sizeLabel, count: inp.count,
            imageRefs: inp.imageRefs, inputUrls, seed: inp.seed, width: inp.width, height: inp.height, bboxList: inp.bboxList, // 重新生成回放用
          };
        } else if (j.type === 'video_t2v') {
          // 文生视频卡片:显模型/分辨率/时长/比例;回放 mode/audio/negative/promptExtend(重新生成/重新提示)。
          const vdef = getVideoModel(inp.model);
          const sizeLabel = inp.resolution || (vdef.shape === 'V_KLING' ? klingModeToResolution(inp.mode) : '720P');
          meta = {
            model: inp.model, modelLabel: vdef.label, mode: inp.mode,
            ratio: inp.ratio, resolution: inp.resolution, sizeLabel, duration: inp.duration,
            audio: inp.audio, negativePrompt: inp.negativePrompt, promptExtend: inp.promptExtend, seed: inp.seed,
          };
        }
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
        ...meta,
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

  // 输入图签名 URL(图生图记录卡显示 + 重新提示回填)。
  const inp = payload.input as { imageRefs?: string[] } | undefined;
  if (inp?.imageRefs?.length) payload.inputUrls = await signInputUrls(inp.imageRefs);

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
