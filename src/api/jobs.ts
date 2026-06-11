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
import {
  signOutputUrls,
  getSignedUrl,
  putObject,
  getObject,
  parseOutputKeys,
} from '../storage/index.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import {
  estimateCost,
  estimateImageCost,
  estimateImageEditCost,
  estimateTtsCost,
  estimateVideoCost,
  estimateAiMusicCost,
  AI_MUSIC_RESERVE_SECONDS,
  clampImageCount,
  reserve,
  balance,
} from '../credits/index.js';
import { audit } from '../audit/index.js';
import { isUsableAvatar } from '../avatars/index.js';
import { isUsableVoice } from '../voices/index.js';
import { getEmotion, EMOTIONS, getSpeed, SPEEDS, getLanguage, LANGUAGES } from '../gateway/tts-models.js';
import { db } from '../db/index.js';
import type { VideoGenInput, ImageGenInput, TtsGenInput, VideoGenT2VInput, AiMusicGenInput } from '../gateway/types.js';
import { getImageModel, resolutionAllowed, isKnownModel, listEnabledModels, DEFAULT_IMAGE_MODEL, tierFromPixels } from '../gateway/image-models.js';
import { getVideoModel, isKnownVideoModel, listVideoModels, klingModeToResolution, getI2VModel, listI2VModels, getEditModel, listEditModels, type VideoTask, type VideoModelDef } from '../gateway/video-models.js';
import { probeVideoMeta, type VideoMeta } from '../pipeline/ai-label.js';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';

export const jobsRouter = Router();

// 图生图/i2v 输入图上传:multer 内存缓冲,≤30MB,最多 9 张(i2v 参考生 HappyHorse-r2v 上限;各 model 上限在 builder 校验)。
const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

// 视频编辑输入视频上传:走临时磁盘(eng-review A2:100MB 进内存有并发 OOM 风险),
// 探测/落 MinIO 后 finally 删临时文件。
const videoUpload = multer({ dest: tmpdir(), limits: { fileSize: 100 * 1024 * 1024 } });

// ── 视频编辑 sidecar 元数据(eng-review D5:时长服务端真相)──
// 上传时 ffprobe → {key}.meta.json 写 MinIO;build/estimate 按 videoRef 读回算计费快照。
// 绝不信任客户端上报的时长(可伪造少付,对抗测试覆盖)。
function videoMetaKey(videoRef: string): string {
  return `${videoRef}.meta.json`;
}
async function readVideoSidecar(videoRef: string): Promise<VideoMeta | null> {
  try {
    const buf = await getObject(videoMetaKey(videoRef));
    const m = JSON.parse(buf.toString('utf8')) as Partial<VideoMeta>;
    if (typeof m.duration === 'number' && m.duration > 0 && typeof m.width === 'number' && typeof m.height === 'number') {
      return { duration: m.duration, width: m.width, height: m.height };
    }
    return null;
  } catch {
    return null;
  }
}
/** 计费秒 = 输入 + 预计输出(贴厂商 usage.duration=in+out;CEO D3)。
 *  HH:输出 = min(输入, 15);wan:输出 = 截断生效 ? min(截断, 输入) : 输入。 */
function editBillableSeconds(def: VideoModelDef, inDur: number, truncate?: number): number {
  let out = inDur;
  if (def.maxOutSeconds) out = Math.min(out, def.maxOutSeconds);
  if (def.supportsTruncate && truncate && truncate > 0) out = Math.min(out, truncate);
  return inDur + out;
}

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

/** 校验并构建 tts(文转语音)job 入参 + 计价。
 *  全 Qwen-TTS:无「品质」模型选择(系统按是否带情绪自动选 flash/instruct,见 worker.resolveVoice)。
 *  计价扁价(estimateTtsCost 默认 0.02/字);情绪/音高对所有音色开放(系统音色用 instruct 落地)。 */
function buildTtsJob(body: Record<string, unknown>, tid: string): JobBuildResult {
  const { text, voiceRef } = body as Partial<TtsGenInput>;
  if (!text || typeof text !== 'string' || text.trim().length === 0)
    return { ok: false, status: 400, error: '缺少 text(配音文本)' };
  if (!voiceRef || typeof voiceRef !== 'string')
    return { ok: false, status: 400, error: '缺少 voiceRef(音色)' };
  if (!isUsableVoice(voiceRef, tid))
    return { ok: false, status: 400, error: '音色不可用(不存在或非本机构)' };

  // 情绪 / 语速 / 音高(T-TTS-EMOTION):Qwen 系统音色经 instruct 模型落地;复刻/设计忽略(worker 处理)。
  // 语言(language_type):对所有音色生效(合成参数,非指令)。
  const { emotion, rate, pitch, language } = body as Partial<TtsGenInput>;
  if (emotion !== undefined && !getEmotion(emotion))
    return { ok: false, status: 400, error: '情绪非法' };
  if (rate !== undefined && !getSpeed(rate))
    return { ok: false, status: 400, error: '语速档位非法' };
  if (pitch !== undefined && (typeof pitch !== 'number' || pitch < -12 || pitch > 12))
    return { ok: false, status: 400, error: '音高需在 -12~+12 之间' };
  if (language !== undefined && !getLanguage(language))
    return { ok: false, status: 400, error: '语言非法' };

  const input: TtsGenInput = { text, voiceRef };
  if (emotion !== undefined && emotion !== 'auto') input.emotion = emotion;
  if (rate !== undefined && rate !== 'normal') input.rate = rate;
  if (pitch !== undefined && pitch !== 0) input.pitch = pitch;
  if (language !== undefined && language !== 'Auto') input.language = language;
  return {
    ok: true,
    type: 'tts',
    input: input as unknown as Record<string, unknown>,
    cost: estimateTtsCost(text.length),
  };
}

// AI 音乐(Fun-Music)合法模型 + 文本上限(官方文档)。
const AI_MUSIC_MODELS = new Set(['fun-music-preview', 'fun-music-v1']);
/** 校验并构建 ai_music(AI 音乐)job 入参 + 计价。
 *  mode=song:prompt 或 lyrics 至少一个(同传仅 lyrics 生效),可带 gender。
 *  mode=instrumental:仅 prompt(无 lyrics/gender)。
 *  计价按慷慨上限秒预估(reserve);worker 完成后按实际 usage.duration 结算并封顶 reserved(只退不补)。 */
function buildAiMusicJob(body: Record<string, unknown>): JobBuildResult {
  const { mode, prompt, lyrics, gender, model } = body as Partial<AiMusicGenInput>;
  if (mode !== 'song' && mode !== 'instrumental')
    return { ok: false, status: 400, error: '缺少 mode(song / instrumental)' };

  const hasPrompt = typeof prompt === 'string' && prompt.trim().length > 0;
  const hasLyrics = typeof lyrics === 'string' && lyrics.trim().length > 0;

  if (mode === 'instrumental') {
    if (hasLyrics) return { ok: false, status: 400, error: '纯音乐不支持歌词' };
    if (gender !== undefined) return { ok: false, status: 400, error: '纯音乐不支持人声性别' };
    if (!hasPrompt) return { ok: false, status: 400, error: '请输入音乐描述(提示词)' };
  } else {
    // song:prompt 或 lyrics 至少一个
    if (!hasPrompt && !hasLyrics) return { ok: false, status: 400, error: '请输入提示词或歌词' };
    if (gender !== undefined && gender !== 'male' && gender !== 'female')
      return { ok: false, status: 400, error: '人声性别非法' };
  }
  // 文本长度(官方:prompt 1~2000;lyrics 中文 5~350 / 英文 5~2000 → 取宽松 5~2000)。
  if (hasPrompt && prompt!.length > 2000) return { ok: false, status: 400, error: '提示词最多 2000 字' };
  if (hasLyrics && (lyrics!.trim().length < 5 || lyrics!.length > 2000))
    return { ok: false, status: 400, error: '歌词需 5~2000 字' };
  if (model !== undefined && !AI_MUSIC_MODELS.has(model))
    return { ok: false, status: 400, error: '音乐模型非法' };

  const input: AiMusicGenInput = { mode };
  if (hasPrompt) input.prompt = prompt!.trim();
  if (hasLyrics) input.lyrics = lyrics!.trim();
  if (mode === 'song' && (gender === 'male' || gender === 'female')) input.gender = gender;
  if (model !== undefined) input.model = model;
  return {
    ok: true,
    type: 'ai_music',
    input: input as unknown as Record<string, unknown>,
    // 预估按慷慨上限秒(reserve);worker 结算按实际秒并封顶 reserved。estimate≡build 同口径。
    cost: estimateAiMusicCost(AI_MUSIC_RESERVE_SECONDS),
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

/** 校验并构建 video_i2v(图转影片)job 入参 + 计价。task 感知(R1.3/R1.4):
 *  - first_frame / first_last task:跳过 ratio(跟首帧);prompt 可选。
 *  - reference task:有 ratio(model 声明);prompt 必填(含 [图N] 指代)。
 *  - media 组合校验(R3.2,reserve 前):first_frame=1图、first_last=2图、reference=1..maxRefImages 图。 */
function buildVideoI2VJob(body: Record<string, unknown>): JobBuildResult {
  const modelKey = typeof body.model === 'string' ? body.model : undefined;
  if (modelKey && (!isKnownVideoModel(modelKey) || getVideoModel(modelKey).tasks.length === 0))
    return { ok: false, status: 400, error: '未知图转影片模型' };
  const def = getI2VModel(modelKey);

  // task 校验(在 model.tasks)
  const task = (typeof body.task === 'string' ? body.task : '') as VideoTask;
  if (!def.tasks.includes(task)) return { ok: false, status: 400, error: '该模型不支持所选任务' };

  // media 组合校验(reserve 前,R3.2):按 task 定图数。
  const refs = Array.isArray(body.imageRefs)
    ? body.imageRefs.filter((k): k is string => typeof k === 'string')
    : [];
  if (task === 'first_frame' && refs.length !== 1)
    return { ok: false, status: 400, error: '首帧任务须上传 1 张首帧图' };
  if (task === 'first_last' && refs.length !== 2)
    return { ok: false, status: 400, error: '首尾帧任务须上传開始图 + 結束图(共 2 张)' };
  if (task === 'reference') {
    const max = def.maxRefImages ?? 1;
    if (refs.length < 1 || refs.length > max)
      return { ok: false, status: 400, error: `参考生须上传 1–${max} 张参考图` };
  }

  // prompt task 感知(R1.4):参考生必填;首帧/首尾帧可选。
  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  if (def.promptRequired && !prompt.trim())
    return { ok: false, status: 400, error: '参考生任务须输入描述(含 [图N] 指代)' };
  if (prompt.length > def.maxPromptChars)
    return { ok: false, status: 400, error: `提示词超过 ${def.maxPromptChars} 字上限`, extra: { length: prompt.length } };

  // ratio task 感知(R1.3):仅 reference task 且 model 声明 ratios 时校验/取;首帧/首尾帧跳过。
  let ratio: string | undefined;
  if (task === 'reference' && def.ratios.length) {
    ratio = typeof body.ratio === 'string' ? body.ratio : def.ratios[0]!;
    if (!def.ratios.includes(ratio)) return { ok: false, status: 400, error: '该模型不支持所选比例' };
  }

  // resolution + duration 校验(同 t2v V_DASH;i2v 全 V_DASH)
  const resolution = typeof body.resolution === 'string' ? body.resolution : '720P';
  if (!def.resolutions.includes(resolution as '720P' | '1080P'))
    return { ok: false, status: 400, error: '该模型不支持所选分辨率' };
  if (body.duration !== undefined) {
    const d = body.duration;
    const [dmin, dmax] = def.durationRange;
    if (typeof d !== 'number' || !Number.isInteger(d) || d < dmin || d > dmax)
      return { ok: false, status: 400, error: `时长需为 ${dmin}–${dmax} 秒之间的整数` };
  }
  if (body.seed !== undefined && (typeof body.seed !== 'number' || body.seed < 0 || body.seed > 2147483647))
    return { ok: false, status: 400, error: 'seed 需在 0–2147483647 之间' };

  // 派生(复用 deriveVideoT2VParams:duration clamp + res 档 + audio;i2v 全 V_DASH 故 audio false)
  const { duration, priceTier } = deriveVideoT2VParams(def, body);

  const input: VideoGenT2VInput = { model: def.key, task, imageRefs: refs, resolution };
  if (prompt.trim()) input.prompt = prompt;
  if (ratio) input.ratio = ratio;
  if (def.supportsNegative && typeof body.negativePrompt === 'string' && body.negativePrompt.trim())
    input.negativePrompt = body.negativePrompt;
  if (def.supportsPromptExtend && typeof body.promptExtend === 'boolean')
    input.promptExtend = body.promptExtend;
  input.duration = duration;
  if (typeof body.seed === 'number') input.seed = body.seed;
  // 快照(reserve==settle):duration/res/priceTier(R5.2:首帧跳 ratio 但仍快照 res);audio 恒 false。
  input.durationSnapshot = duration;
  input.resSnapshot = resolution;
  input.audioSnapshot = false;
  input.priceTierSnapshot = priceTier;

  return {
    ok: true,
    type: 'video_i2v',
    input: input as unknown as Record<string, unknown>,
    cost: estimateVideoCost(duration, priceTier, resolution, false),
  };
}

/** 校验并构建 video_edit(视频编辑)job 入参 + 计价。
 *  时长真相只认 sidecar(eng-review D5/E5):客户端 body 里的 duration/billableSeconds
 *  一概忽略,伪造无效。async:builder 通道已放宽支持 Promise(eng-review E1)。 */
async function buildVideoEditJob(body: Record<string, unknown>): Promise<JobBuildResult> {
  const modelKey = typeof body.model === 'string' ? body.model : undefined;
  if (modelKey && (!isKnownVideoModel(modelKey) || !getVideoModel(modelKey).tasks.includes('edit')))
    return { ok: false, status: 400, error: '未知的视频编辑模型' };
  const def = getEditModel(modelKey);

  // 输入视频:必传 + sidecar 元数据回读(服务端真相)
  const videoRef = typeof body.videoRef === 'string' ? body.videoRef : '';
  if (!videoRef) return { ok: false, status: 400, error: '请先上传视频' };
  const meta = await readVideoSidecar(videoRef);
  if (!meta) return { ok: false, status: 400, error: '视频元数据丢失,请重新上传' };

  // 逐模型输入时长界(HH 3-60 / wan 2-10)
  const [vmin, vmax] = def.videoDurRange ?? [2, 60];
  if (meta.duration < vmin || meta.duration > vmax)
    return { ok: false, status: 400, error: `${def.label} 限 ${vmin}-${vmax} 秒输入视频(当前 ${meta.duration.toFixed(1)} 秒)` };

  // 参考图 0..maxRefImages
  const refs = Array.isArray(body.imageRefs)
    ? body.imageRefs.filter((k): k is string => typeof k === 'string')
    : [];
  const maxRefs = def.maxRefImages ?? 0;
  if (refs.length > maxRefs)
    return { ok: false, status: 400, error: `参考图最多 ${maxRefs} 张` };

  // prompt:HH 必填 / wan 可选;字数上限
  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  if (def.promptRequired && !prompt.trim())
    return { ok: false, status: 400, error: '请输入编辑指令(如:换装/风格化/局部替换)' };
  if (prompt.length > def.maxPromptChars)
    return { ok: false, status: 400, error: `提示词超过 ${def.maxPromptChars} 字上限`, extra: { length: prompt.length } };

  // resolution
  const resolution = typeof body.resolution === 'string' ? body.resolution : '720P';
  if (!def.resolutions.includes(resolution as '720P' | '1080P'))
    return { ok: false, status: 400, error: '该模型不支持所选分辨率' };

  // ratio:仅 wan(ratios 非空)且用户显式指定;缺省 = 跟原视频(不传)
  let ratio: string | undefined;
  if (typeof body.ratio === 'string' && body.ratio) {
    if (!def.ratios.length || !def.ratios.includes(body.ratio))
      return { ok: false, status: 400, error: '该模型不支持所选比例' };
    ratio = body.ratio;
  }

  // 截断时长:仅 wan;2-10 整数;≥输入时长则无意义 → 拒(避免用户误解)
  let truncate: number | undefined;
  if (body.truncateDuration !== undefined) {
    const t = body.truncateDuration;
    if (!def.supportsTruncate) return { ok: false, status: 400, error: '该模型不支持截断时长' };
    if (typeof t !== 'number' || !Number.isInteger(t) || t < 2 || t > 10)
      return { ok: false, status: 400, error: '截断时长需为 2-10 秒之间的整数' };
    if (t < meta.duration) truncate = t; // ≥输入时长 = 不截断,静默忽略
  }

  // audio_setting:auto(缺省)/ origin
  let audioSetting: 'auto' | 'origin' | undefined;
  if (body.audioSetting !== undefined) {
    if (body.audioSetting !== 'auto' && body.audioSetting !== 'origin')
      return { ok: false, status: 400, error: 'audioSetting 仅支持 auto / origin' };
    if (body.audioSetting === 'origin') audioSetting = 'origin';
  }

  if (body.seed !== undefined && (typeof body.seed !== 'number' || body.seed < 0 || body.seed > 2147483647))
    return { ok: false, status: 400, error: 'seed 需在 0–2147483647 之间' };

  // 计费秒 = 输入 + 预计输出(贴厂商;客户端传来的任何时长字段到不了这里)
  const billable = editBillableSeconds(def, meta.duration, truncate);

  const input: VideoGenT2VInput = { model: def.key, task: 'edit', videoRef, imageRefs: refs, resolution };
  if (prompt.trim()) input.prompt = prompt;
  if (ratio) input.ratio = ratio;
  if (truncate) input.truncateDuration = truncate;
  if (audioSetting) input.audioSetting = audioSetting;
  if (def.supportsNegative && typeof body.negativePrompt === 'string' && body.negativePrompt.trim())
    input.negativePrompt = body.negativePrompt;
  if (def.supportsPromptExtend && typeof body.promptExtend === 'boolean')
    input.promptExtend = body.promptExtend;
  if (typeof body.seed === 'number') input.seed = body.seed;
  // 快照(reserve==settle)
  input.resSnapshot = resolution;
  input.priceTierSnapshot = def.priceTier;
  input.audioSnapshot = false;
  input.inputDurationSnapshot = meta.duration;
  input.billableSecondsSnapshot = billable;

  return {
    ok: true,
    type: 'video_edit',
    input: input as unknown as Record<string, unknown>,
    cost: estimateVideoCost(billable, def.priceTier, resolution, false),
  };
}

// 封闭 allowlist:type → builder。Object.create(null) 防原型链污染(type='__proto__' 取不到)。
// builder 可同步可异步(eng-review E1:video_edit 须 await 读 sidecar;同步 builder 被 await 后行为不变)。
const JOB_BUILDERS: Record<string, (body: Record<string, unknown>, tid: string) => JobBuildResult | Promise<JobBuildResult>> =
  Object.assign(Object.create(null), {
    video: buildVideoJob,
    ai_image: (body: Record<string, unknown>) => buildImageJob(body),
    video_t2v: (body: Record<string, unknown>) => buildVideoT2VJob(body),
    video_i2v: (body: Record<string, unknown>) => buildVideoI2VJob(body),
    video_edit: (body: Record<string, unknown>) => buildVideoEditJob(body),
    tts: buildTtsJob,
    ai_music: (body: Record<string, unknown>) => buildAiMusicJob(body),
  });

// 提交生成 — 仅 admin/creator(viewer 不能发起生成,验收第8条)
jobsRouter.post('/jobs', requireRole('admin', 'creator'), async (req: Request, res: Response) => {
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

  const built = await builder(body, tid);
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
    { name: 'images', maxCount: 9 }, // i2v 参考生 HappyHorse-r2v 1-9 张(R2.2);各模型上限在 builder maxRefImages 校验
    { name: 'proof', maxCount: 1 },
  ]),
  async (req: Request, res: Response) => {
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const images = files?.images ?? [];
    const proof = files?.proof?.[0];
    const consent = req.body?.consent === 'true' || req.body?.consent === true;
    const tid = req.user!.tenantId;

    if (images.length === 0) return res.status(400).json({ error: '缺少图片(images)' });
    if (images.length > 9) return res.status(400).json({ error: '最多 9 张输入图' });
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

// ── 视频编辑输入视频上传 ──
// 仅 admin/creator + consent(含人视频编辑=深度合成真人,合规口径同输入图)。
// 流程:multer 临时盘 → ffprobe(严格:失败即 400,计费真相不可缺)→ 校验格式/时长下限
// → 落 MinIO(视频 + {key}.meta.json sidecar)→ finally 删临时文件。
// 逐模型时长上界在 buildVideoEditJob 按所选模型校验(此处只挡通用下限 2s / 上限 60s 全集)。
jobsRouter.post(
  '/video-uploads',
  requireRole('admin', 'creator'),
  videoUpload.single('video'),
  async (req: Request, res: Response) => {
    const file = req.file;
    const consent = req.body?.consent === 'true' || req.body?.consent === true;
    const tid = req.user!.tenantId;
    if (!file) return res.status(400).json({ error: '缺少视频文件(video)' });
    const cleanup = () => unlink(file.path).catch(() => {});
    try {
      // 格式:MP4 / MOV(防御纵深:前端已拦,客户端可绕过 → 后端再验)。
      const OK_VIDEO = new Set(['video/mp4', 'video/quicktime']);
      const extOk = /\.(mp4|mov)$/i.test(file.originalname || '');
      if (!OK_VIDEO.has(file.mimetype) && !extOk) {
        return res.status(400).json({ error: `不支持的格式 ${file.mimetype || '未知'},请上传 MP4/MOV` });
      }
      if (!consent) {
        return res.status(400).json({ error: '必须勾选"已获视频中人物授权"(政企合规)' });
      }
      // ffprobe 严格模式(eng-review E4):时长是计费真相,probe 失败必须拒,不可优雅放行。
      const meta = await probeVideoMeta(file.path);
      if (!meta) {
        return res.status(400).json({ error: '无法解析视频,请检查文件是否完整(需 MP4/MOV)' });
      }
      // 通用时长界(全模型并集 2-60s);逐模型界在提交时按所选模型再验。
      if (meta.duration < 2 || meta.duration > 60) {
        return res.status(400).json({ error: `视频时长需在 2-60 秒之间(当前 ${meta.duration.toFixed(1)} 秒)` });
      }
      const ext = /\.mov$/i.test(file.originalname || '') ? 'mov' : 'mp4';
      const key = `video-inputs/${tid}/${randomUUID()}.${ext}`;
      const buf = await readFile(file.path);
      await putObject(key, buf, file.mimetype || 'video/mp4');
      // sidecar:时长真相(build/estimate 只认它,客户端上报无效)
      await putObject(videoMetaKey(key), JSON.stringify({ ...meta, size: file.size }), 'application/json');
      // 授权存证(同输入图口径)
      db.prepare(
        `INSERT INTO authorization (id,tenant_id,subject_type,consent,proof_key,terms_version,created_by,created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(randomUUID(), tid, 'video-edit', 1, null, 'v1', req.user!.id, Date.now());
      console.log(`[video-uploads] tenant=${tid} key=${key} size=${file.size} dur=${meta.duration.toFixed(2)}s ${meta.width}x${meta.height}`);
      return res.json({ videoRef: key, duration: meta.duration, width: meta.width, height: meta.height });
    } catch (e) {
      return res.status(500).json({ error: e instanceof Error ? e.message : '上传失败' });
    } finally {
      void cleanup();
    }
  },
);

// 费用预估(生成前展示,验收第4条)。按 type 计价;默认 video。
jobsRouter.post('/jobs/estimate', requireAuth, async (req: Request, res: Response) => {
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
  if (type === 'video_i2v') {
    // 与 buildVideoI2VJob 同派生(audio 恒 false;i2v 全 V_DASH)。res 用 body.resolution。
    const def = getI2VModel(typeof body.model === 'string' ? body.model : undefined);
    const { duration, resolution, priceTier } = deriveVideoT2VParams(def, body);
    return res.json({ cost: estimateVideoCost(duration, priceTier, resolution, false) });
  }
  if (type === 'video_edit') {
    // 与 buildVideoEditJob 同读 sidecar(时长服务端真相,estimate≡build → reserve==settle)。
    const def = getEditModel(typeof body.model === 'string' ? body.model : undefined);
    const videoRef = typeof body.videoRef === 'string' ? body.videoRef : '';
    if (!videoRef) return res.status(400).json({ error: '请先上传视频' });
    const meta = await readVideoSidecar(videoRef);
    if (!meta) return res.status(400).json({ error: '视频元数据丢失,请重新上传' });
    const truncate = def.supportsTruncate && typeof body.truncateDuration === 'number' ? body.truncateDuration : undefined;
    const billable = editBillableSeconds(def, meta.duration, truncate);
    const resolution = typeof body.resolution === 'string' && def.resolutions.includes(body.resolution as '720P' | '1080P')
      ? body.resolution : def.resolutions[0]!;
    return res.json({ cost: estimateVideoCost(billable, def.priceTier, resolution, false), inputDuration: meta.duration });
  }
  if (type === 'tts') {
    // 全 Qwen-TTS 扁价(无品质模型);estimate≡build → reserve==settle。
    return res.json({
      cost: estimateTtsCost(typeof body.text === 'string' ? body.text.length : 0),
    });
  }
  if (type === 'ai_music') {
    // 按慷慨上限秒预估(与 buildAiMusicJob 同口径);完成后按实际秒结算并封顶 reserved。
    return res.json({ cost: estimateAiMusicCost(AI_MUSIC_RESERVE_SECONDS) });
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

// TTS 情绪 + 语速选项清单(T-TTS-EMOTION)— 前端下拉真相源。
// 全 Qwen-TTS:无「品质」模型选择(系统按是否带指令自动选 flash/instruct)。
// 只吐 key/label,instruction 文本留后端。
jobsRouter.get('/tts-models', requireAuth, (_req: Request, res: Response) => {
  const emotions = Object.values(EMOTIONS).map((e) => ({ key: e.key, label: e.label }));
  const speeds = Object.values(SPEEDS).map((s) => ({ key: s.key, label: s.label }));
  const languages = Object.values(LANGUAGES).map((l) => ({ key: l.key, label: l.label }));
  res.json({ emotions, speeds, languages });
});

// 文生视频模型清单 — 前端下拉单一真相源(只吐 UI 能力字段,不漏 modelId/priceTier)。
// 仅 t2v 模型(tasks 空);i2v 走 /i2v-models。
jobsRouter.get('/video-models', requireAuth, (_req: Request, res: Response) => {
  const models = listVideoModels()
    .filter((d) => d.tasks.length === 0)
    .map((d) => ({
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

// 图转影片模型清单 — img2video 页下拉真相源(吐 tasks/maxRefImages/promptRequired 供 tab 显隐 + 校验)。
jobsRouter.get('/i2v-models', requireAuth, (_req: Request, res: Response) => {
  const models = listI2VModels().map((d) => ({
    key: d.key,
    label: d.label,
    resolutions: d.resolutions,
    ratios: d.ratios, // 空=首帧/首尾帧跟首帧(前端不显比例);非空=参考生显比例
    durationRange: d.durationRange,
    defaultDuration: d.defaultDuration,
    maxPromptChars: d.maxPromptChars,
    supportsNegative: d.supportsNegative,
    supportsPromptExtend: d.supportsPromptExtend,
    tasks: d.tasks, // 前端据此显隐 tab(first_frame/first_last/reference)
    maxRefImages: d.maxRefImages, // 参考生上限
    promptRequired: d.promptRequired, // 参考生 prompt 必填
  }));
  res.json({ models, default: getI2VModel().key });
});

// 视频编辑模型清单 — video-edit 页下拉真相源(吐输入视频约束供前端校验/文案,不漏 priceTier)。
jobsRouter.get('/edit-models', requireAuth, (_req: Request, res: Response) => {
  const models = listEditModels().map((d) => ({
    key: d.key,
    label: d.label,
    resolutions: d.resolutions,
    ratios: d.ratios, // 空=输出跟输入(HH);非空=可指定(wan,前端首格「跟原视频」)
    maxPromptChars: d.maxPromptChars,
    promptRequired: d.promptRequired, // HH 必填 / wan 可选
    maxRefImages: d.maxRefImages, // 参考图上限(HH 5 / wan 4)
    supportsNegative: d.supportsNegative,
    supportsPromptExtend: d.supportsPromptExtend,
    videoDurRange: d.videoDurRange, // 输入视频时长界(切模型即时重验 + 空态文案)
    videoMaxMB: d.videoMaxMB,
    maxOutSeconds: d.maxOutSeconds, // HH=15(估价说明)
    supportsTruncate: d.supportsTruncate, // wan 截断时长档
    supportsAudioOrigin: d.supportsAudioOrigin, // 保留原声 toggle
  }));
  res.json({ models, default: getEditModel().key });
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
          duration?: number; audio?: boolean; negativePrompt?: string; promptExtend?: boolean; task?: string;
          videoRef?: string; truncateDuration?: number; audioSetting?: string; inputDurationSnapshot?: number;
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
        } else if (j.type === 'video_i2v') {
          // 图转影片卡片:显模型/任务/分辨率/时长 + 输入图缩略;回放 task/imageRefs。
          const idef = getI2VModel(inp.model);
          const inputUrls = await signInputUrls(inp.imageRefs);
          meta = {
            model: inp.model, modelLabel: idef.label, task: inp.task,
            ratio: inp.ratio, resolution: inp.resolution, sizeLabel: inp.resolution || '720P', duration: inp.duration,
            negativePrompt: inp.negativePrompt, promptExtend: inp.promptExtend, seed: inp.seed,
            imageRefs: inp.imageRefs, inputUrls, // 输入图缩略 + 重新生成回放
          };
        } else if (j.type === 'video_edit') {
          // 视频编辑卡片:显模型/分辨率/输入时长 chip + 输入视频原片 + 参考图缩略;回放 videoRef/imageRefs(免重传 100MB)。
          const edef = getEditModel(inp.model);
          const inputUrls = await signInputUrls(inp.imageRefs);
          // 输入视频签名 URL(video-inputs key 同桶,复用 getSignedUrl):记录卡显原片 + 重新提示左侧显视频预览。
          const inputVideoUrl = inp.videoRef ? await getSignedUrl(inp.videoRef).catch(() => null) : null;
          meta = {
            model: inp.model, modelLabel: edef.label, task: 'edit',
            ratio: inp.ratio, resolution: inp.resolution, sizeLabel: inp.resolution || '720P',
            inputDuration: inp.inputDurationSnapshot, truncateDuration: inp.truncateDuration, audioSetting: inp.audioSetting,
            negativePrompt: inp.negativePrompt, promptExtend: inp.promptExtend, seed: inp.seed,
            videoRef: inp.videoRef, inputVideoUrl, imageRefs: inp.imageRefs, inputUrls,
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
  const inp = payload.input as { imageRefs?: string[]; videoRef?: string } | undefined;
  if (inp?.imageRefs?.length) payload.inputUrls = await signInputUrls(inp.imageRefs);
  // 视频编辑:输入视频签名 URL(记录卡显原片 + 重新提示视频预览,video-inputs 同桶)。
  if (inp?.videoRef) payload.inputVideoUrl = await getSignedUrl(inp.videoRef).catch(() => null);

  if (job.status === 'done' && job.output_url) {
    const outputUrls = await signOutputUrls(job.output_url);
    payload.outputUrls = outputUrls; // 多产物(图片多图)
    payload.videoUrl = outputUrls[0] ?? null; // 兼容旧前端字段
    if (outputUrls.length === 0) payload.warn = '成品已生成但签名 URL 暂不可用';
  }

  return res.json(payload);
});

// 成品下载代理 — 同源强制下载,根治「下载一闪而过」。
// 根因:OSS 签名 URL 无 CORS 头,前端 fetch(签名URL) 被浏览器 CORS 拦截 → 回落
// window.open 打开图片直链 → 一闪而过。改由后端拉对象、加 Content-Disposition:
// attachment 回传(同源,无 CORS,<a download> 直接生效)。覆盖图/视频/未来音频。
// 鉴权:复用 getJobForTenant 做租户隔离,只能下本机构的成品;越权/越界一律 404。
jobsRouter.get('/jobs/:id/download/:idx', requireAuth, async (req: Request, res: Response) => {
  const job = getJobForTenant(req.params.id!, req.user!.tenantId);
  // 不存在 / 非本租户 / 未完成 / 无产物 → 统一 404(不泄露任务存在性)
  if (!job || job.status !== 'done' || !job.output_url) return res.status(404).end();

  const keys = parseOutputKeys(job.output_url);
  const idx = Number(req.params.idx);
  if (!Number.isInteger(idx) || idx < 0 || idx >= keys.length) return res.status(404).end();
  const key = keys[idx]!;

  // 扩展名:按 output_kind 给默认,再让 key 自带后缀覆盖(音频可能是 mp3/wav/m4a)
  const extFromKey = (key.split('?')[0]!.match(/\.([a-z0-9]{2,4})$/i) || [])[1];
  const kindExt: Record<string, string> = { image: 'png', video: 'mp4', audio: 'mp3' };
  const ext = (extFromKey || kindExt[job.output_kind] || 'bin').toLowerCase();
  const mimes: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
    mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4',
  };

  let buf: Buffer;
  try {
    buf = await getObject(key);
  } catch {
    return res.status(502).json({ error: '成品暂不可下载,请稍后重试' });
  }

  const filename = `lingjing-${job.id}-${idx + 1}.${ext}`;
  res.setHeader('Content-Type', mimes[ext] || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', String(buf.length));
  res.setHeader('Cache-Control', 'private, max-age=0, no-store');
  return res.end(buf);
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
