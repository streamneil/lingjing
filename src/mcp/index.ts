// 灵镜 Open API — MCP server(设计文档 §5,PR2;v0.9.2 全量补全)。
//
// 面向 Claude Code / Cursor 等 Agent 的原生接入。stateless Streamable HTTP:每请求新建
// transport + server(无会话,重启无状态丢失,外部声音 #8)。同一把 lj_sk_ 密钥认证 + 同款读写限速。
// 工具直接调 submitJob() / quoteJob() / 模型&发现函数(不 HTTP 自调用,D4)。
//
// 全工具异步口径(D9):generate_* 提交即返 job_id,get_job 取结果 —— Agent 端一套逻辑,无悬挂。
// 挂载:在全局 attachUser / requireApiScope 之前独立挂 /mcp(自带认证,不进 /api 中间件栈,同 /admin 隔离)。
//
// ── 请求管线(顺序有讲究,别重排)────────────────────────────────────────────
//   [1] 认证 + 角色闸 + 粗速率闸   ← 必须在 parser 之前(见文件末尾的内存放大注释)
//   [2] 并发字节闸                 ← 同上;速率闸管「几次/分钟」,它管「同时多少字节在飞」
//   [3] express.json(32mb) + 413 兜底
//   [4] 精确读写限速(tools/call=写,其余=读)
//   [5] 新建 server + transport → handleRequest

import type { NextFunction, Request, Response } from 'express';
import express, { Router } from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { resolveApiKeyFull } from '../auth/api-keys.js';
import type { AuthedUser } from '../auth/index.js';
import { SlidingWindowLimiter } from '../auth/rate-limit.js';
import {
  submitJob, quoteJob, storeImageInputs, storeVideoInput, storeAudioInput, clientIpOf,
  listEnabledImageModels, projectImageModel, projectT2VModel, projectI2VModel, projectR2VModel, projectEditModel,
  type SubmitActor, type UploadFile,
} from '../api/jobs.js';
import { getJobForTenant, listJobsForTenant } from '../queue/index.js';
import { balance } from '../credits/index.js';
import { signOutputUrls } from '../storage/index.js';
import { listVideoModels, listI2VModels, listR2VModels, listEditModels } from '../gateway/video-models.js';
import { EMOTIONS, SPEEDS, LANGUAGES } from '../gateway/tts-models.js';
import { listCustom as listAvatars, listPresets as listAvatarPresets } from '../avatars/index.js';
import { listClones as listVoices, listPresets as listVoicePresets } from '../voices/index.js';

// 限速:与 REST 同口径(写 60/min、读 300/min per key)。MCP 的 tools/call 生成算写,其余算读。
const WRITE_PER_MIN = Number(process.env.API_RATE_WRITE_PER_MIN) || 60;
const READ_PER_MIN = Number(process.env.API_RATE_READ_PER_MIN) || 300;
const writeLimiter = new SlidingWindowLimiter(60_000, WRITE_PER_MIN);
const readLimiter = new SlidingWindowLimiter(60_000, READ_PER_MIN);

// 握手时回给 Agent 的版本号。写死会与 VERSION 漂移(T-MCP-VERSION-DRIFT:客户排查问题时对不上号),
// 故启动期从 package.json 读一次。读不到不该让服务起不来 —— 回落一个显眼的哨兵值。
const SERVER_VERSION = ((): string => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(here, '../../package.json'), 'utf8')).version || '0.0.0-unknown';
  } catch {
    return '0.0.0-unknown';
  }
})();

// ── 机器可读错误码(与 api-docs §9 同一张表)────────────────────────────────
// Agent 靠 code 决定「重试 / 改参数 / 放弃去问人」三选一。中文文案它读得懂但没法可靠分类。
// 常量化的意义在于新增工具时无处自造 —— 上一版有五个码是各写各的,一个都没进文档。
const CODE = {
  INVALID_PARAMS: 'INVALID_PARAMS',          // 400 参数错(含 submitJob 那一堆无码 400) 不重试
  INVALID_INPUT_FILE: 'INVALID_INPUT_FILE',  // 400 文件格式 / 大小                      不重试
  NOT_FOUND: 'NOT_FOUND',                    // 404 任务不存在或无权访问                 不重试
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',    // 413 请求体超限                           不重试
  RATE_LIMITED: 'RATE_LIMITED',              // 429 限速 / 上传通道繁忙                   是(退避)
  UPLOAD_FAILED: 'UPLOAD_FAILED',            // 500 存储写失败                           是
  UNAUTHORIZED: 'UNAUTHORIZED',              // 401                                      不重试
  ROLE_FORBIDDEN: 'ROLE_FORBIDDEN',          // 403 角色不允许生成(防御性,见下)          不重试
  // 下面两个由 submitJob 产生并原样透传。放进表里不是为了在本文件里用,而是因为这张表
  // 声称「与 api-docs §9 同一张表」——漏一个,Agent 就会拿到一个文档里查不到的码。
  INSUFFICIENT_CREDITS: 'INSUFFICIENT_CREDITS', // 402 余额不足                            不重试(充值后)
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT', // 409 同幂等键但请求体不同                不重试(换键)
  INTERNAL_ERROR: 'INTERNAL_ERROR',          // 500 服务端未预期异常                     是(退避)
} as const;

/** 只读工具:限速走读档(300/min),与 api-docs §7 和各工具的 readOnlyHint 保持一致。
 *  改这里时记得同步 buildMcpServer 里对应工具的 annotations —— 两处说的必须是同一件事。 */
// JSON-RPC batch 的硬上限。MCP 客户端(Claude Code / Cursor)实际都发单条,给 20 是给
// 未来的批量客户端留余地,同时把「一个请求扇出十万次提交」这条路堵死。
const MAX_BATCH_MESSAGES = 20;

const READ_ONLY_TOOL_NAMES = new Set([
  'get_job', 'list_jobs', 'get_balance', 'list_models', 'list_voices', 'list_avatars', 'estimate',
]);

type ToolText = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
const ok = (data: Record<string, unknown>): ToolText => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
const err = (message: string, code: string = CODE.INVALID_PARAMS): ToolText => ({
  content: [{ type: 'text', text: message }],
  structuredContent: { error: message, code },
  isError: true,
});

// ── base64 → UploadFile ──
// MCP 是 JSON-RPC,没有 multipart。Agent 手里是本地文件,故走 base64 内联(见 /mcp 的 body limit)。
// base64 不带 MIME,由扩展名推断 —— 推不出的扩展名直接拒,不猜、不放行:格式校验是深度合成合规链
// 的一环,宁可报错也不能误判成 image/jpeg 放过去。
const IMAGE_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', gif: 'image/gif',
};
const VIDEO_MIME: Record<string, string> = { mp4: 'video/mp4', mov: 'video/quicktime' };
const AUDIO_MIME: Record<string, string> = {
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
};
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

type DecodeOpts = { mimeMap: Record<string, string>; maxBytes: number; anyExt?: boolean; hint: string };

/** base64 → UploadFile。
 *
 *  性能:前缀用 slice 不用 replace —— 字符串不可变,replace 会复制整条载荷(20MB 视频就是
 *  27MB base64 复制一份),而 V8 对大字符串的 slice 是 SlicedString,不真复制。
 *  也不做去空白:Node 的 base64 解码器自己就忽略空白(已实测),那个 replace 是纯浪费的第二份副本。
 *
 *  尺寸闸**只有一道**,判在解码之后的真实字节数上。这里曾经想加一道「解码前按字符串长度粗筛」
 *  省掉 Buffer 分配,但那个判据是错的:raw.length*3/4 是解码后字节数的**上界**,而上界超限
 *  并不代表真实值超限 —— 带折行(PEM 风格)的 base64 会因为空白撑长字符串而被误拒。
 *  旧实现之所以能用长度判,是因为它先 replace 掉了空白,量的是净长度;去掉那次复制后,
 *  唯一还准的量就是 buffer.length。
 *  内存也不需要那道闸兜底:整个请求体已被 express.json 的 MCP_BODY_LIMIT(默认 32mb)和
 *  更前面的并发字节闸夹住,单次解码的上界是确定的。 */
function decodeUpload(filename: string, base64: string, opts: DecodeOpts): UploadFile | { error: string } {
  // 容错:Agent 常直接贴 data URL(data:image/png;base64,xxx),剥掉前缀再解。
  const comma = base64.startsWith('data:') ? base64.indexOf(',') : -1;
  const raw = comma >= 0 ? base64.slice(comma + 1) : base64;
  if (!raw) return { error: `${filename}:内容为空` };
  const mb = Math.round(opts.maxBytes / (1024 * 1024));
  const buffer = Buffer.from(raw, 'base64');
  if (buffer.length === 0) return { error: `${filename}:base64 解码失败` };
  if (buffer.length > opts.maxBytes) return { error: `${filename}:单个文件不能超过 ${mb}MB` };
  const ext = (filename.split('.').pop() || '').toLowerCase();
  // anyExt:授权凭证用。凭证可能是 PDF/扫描件,不该被扩展名白名单误杀 —— 认不出时回落
  // octet-stream 存下,而不是拒收(误杀会把整条合规上传挡死)。素材本身永远不走这条。
  const mimetype = opts.mimeMap[ext] ?? (opts.anyExt ? 'application/octet-stream' : undefined);
  if (!mimetype) return { error: `${filename}:无法识别的扩展名,请用 ${opts.hint}` };
  return { buffer, mimetype, originalname: filename, size: buffer.length };
}

/** 提交类工具的公共收尾:submitJob → {job_id, cost, status} 或错误(透传中文 error + code)。 */
async function submitAndReport(actor: SubmitActor, body: Record<string, unknown>, idempotencyKey?: string): Promise<ToolText> {
  const r = await submitJob(actor, body, idempotencyKey);
  // submitJob 对参数校验类错误不带 code(内容是给人看的中文),回落 INVALID_PARAMS —— 否则
  // Agent 拿到一条没有码的错误,只能猜该不该重试(参数错重试多少次都一样,只会撞到限速)。
  if (!r.ok) return err(r.error, r.code ?? CODE.INVALID_PARAMS);
  return ok({ job_id: r.id, status: r.status, cost: r.cost, reused: r.reused });
}

// ── 生成类工具的公共参数 ────────────────────────────────────────────────────
const DRY_RUN = z.boolean().optional().describe(
  '设为 true 只返回预估费用与当前余额,不提交任务、不扣积分。参数校验与真提交完全一致 —— ' +
  '参数错不会「预估通过、提交被拒」。但提交仍可能因积分不足(INSUFFICIENT_CREDITS)或幂等键冲突' +
  '(IDEMPOTENCY_CONFLICT)失败,所以返回值里一并给出当前余额供你先行比对。',
);
const IDEM_KEY = z.string().optional().describe(
  '幂等键。网络超时后重试同一次请求时传相同值 → 返回原任务,不重复扣费;' +
  '想再生成一份(哪怕参数一样)请换一个新值。',
);

type CommonArgs = { dry_run?: boolean; idempotency_key?: string };

/** 生成工具统一入口:dry_run 走 quoteJob(严格报价),否则 submitJob。
 *  两条路吃同一份 zod schema **且** 同一个 JOB_BUILDERS —— 「报价能过、提交挂了」不再可能。 */
async function runGen(
  actor: SubmitActor, type: string, body: Record<string, unknown>, common: CommonArgs,
): Promise<ToolText> {
  if (common.dry_run) {
    // type 放最后:调用方 body 里若混进 type 键,不能覆盖工具自己的任务类型(否则 generate_image
    // 能提交成 video 走别的 builder 和价格)。目前靠 zod 剥未知键挡着,但那是 SDK 的默认行为,
    // 不该当成安全边界 —— 谁给某个 schema 加个 passthrough 就破了。
    const r = await quoteJob(actor.tenantId, actor.userId, { ...body, type });
    return r.ok ? ok({ cost: r.cost, ...(r.extra ?? {}) }) : err(r.error, CODE.INVALID_PARAMS);
  }
  return submitAndReport(actor, { ...body, type }, common.idempotency_key);
}

/** 从工具入参里摘出公共字段,剩下的原样交给 builder。 */
function split<T extends CommonArgs>(a: T): { common: CommonArgs; body: Record<string, unknown> } {
  const { dry_run, idempotency_key, ...body } = a;
  return { common: { dry_run, idempotency_key }, body: body as Record<string, unknown> };
}

// ── 发现类工具的投影 ────────────────────────────────────────────────────────
// 绝不把内部对象原样 dump:VideoModelDef / ImageModelDef 带 modelId、provider、priceTier*,
// voice / avatar 行带 provider_voice_id、source_key、authorization_id。REST 侧一直是投影后下发的
// (「只吐 UI 能力字段,不漏 modelId/priceTier」),MCP 早期直接 dump —— 等于 API 密钥面泄漏了
// 网页面刻意隐藏的厂商栈,与 PRD §0.1「业务只声明能力,不绑定厂商」相悖。
// 模型投影复用 REST 的同一批 project*Model 函数,字段集不会两边漂。
// 音色/形象则是 MCP 本地投影:REST 的 /api/voices 会为每个克隆音色签一个试听 URL(异步、按行签名),
// 那对 Agent 是纯浪费。两边字段集因此有意不同,不是共用 —— 别照着模型那句话以为它们也共用了。
const projectVoice = (v: { id: string; name: string; kind: string; status: string }) =>
  ({ id: v.id, name: v.name, kind: v.kind, status: v.status });
const projectAvatar = (a: { id: string; name: string; kind: string; status: string; orientation?: string | null }) =>
  ({ id: a.id, name: a.name, kind: a.kind, status: a.status, orientation: a.orientation ?? null });

/** 为某个已认证 actor 构建一台 MCP server(工具闭包绑定其身份 + key id)。 */
function buildMcpServer(actor: SubmitActor, effectiveUploadMB: number): McpServer {
  const server = new McpServer(
    { name: 'lingjing', version: SERVER_VERSION },
    { instructions: instructionsFor(effectiveUploadMB) },
  );

  const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
  const SPENDS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

  // ── 上传 ────────────────────────────────────────────────────────────────
  // 图生图闭环的第一步。缺了它,generate_image 的 imageRefs 参数在 MCP 侧无从填充 ——
  // Agent 只能瞎猜路径、撞上作用域 403,再误判成「密钥权限不足」(v0.8.0.7 修的就是这个)。
  server.registerTool('upload_image',
    {
      title: '上传参考图',
      annotations: { title: '上传参考图', ...SPENDS },
      description: '上传图生图 / 图转影片 / 参考生成影片的输入图,返回 imageRefs(存储 key),' +
        '直接填进 generate_image、generate_video_from_image、generate_video_from_refs 的 imageRefs。' +
        '图片用 base64 内联,单张 ≤10MB、一次 ≤9 张,格式 JPG/PNG/WEBP/BMP/TIFF/GIF(不支持 HEIC)。' +
        '合规:含真人的图必须持有被摄主体授权并传 consent=true(与网页端同一口径,责任主体为你的机构)。' +
        '注意:这不是「数字人形象」——形象只用于口播视频,需在灵镜后台创建,API 侧只读(见 list_avatars)。',
      inputSchema: {
        images: z.array(z.object({
          filename: z.string().describe('带扩展名的文件名,如 ref.png —— 扩展名用于判定格式'),
          data_base64: z.string().describe('图片文件的 base64(可直接贴 data:image/png;base64,… 形式)'),
        })).min(1).max(9),
        consent: z.boolean().describe('已获图中人物授权;含真人的图必须为 true'),
        proof: z.object({ filename: z.string(), data_base64: z.string() }).optional().describe('授权凭证文件(可选存证,支持 PDF/图片扫描件)'),
      },
    },
    async ({ images, consent, proof }) => {
      const files: UploadFile[] = [];
      for (const im of images) {
        const f = decodeUpload(im.filename, im.data_base64, {
          mimeMap: IMAGE_MIME, maxBytes: MAX_IMAGE_BYTES, hint: '.jpg/.png/.webp/.bmp/.tiff/.gif',
        });
        if ('error' in f) return err(f.error, CODE.INVALID_INPUT_FILE);
        files.push(f);
      }
      let proofFile: UploadFile | undefined;
      if (proof) {
        const p = decodeUpload(proof.filename, proof.data_base64, {
          mimeMap: IMAGE_MIME, maxBytes: MAX_IMAGE_BYTES, anyExt: true, hint: '(anyExt 下不可达)',
        });
        if ('error' in p) return err(`授权凭证:${p.error}`, CODE.INVALID_INPUT_FILE);
        proofFile = p;
      }
      const r = await storeImageInputs(
        { tenantId: actor.tenantId, userId: actor.userId, ip: actor.ip ?? null, apiKeyId: actor.apiKeyId },
        files, consent, proofFile,
      );
      if (!r.ok) return err(r.error, r.status === 400 ? CODE.INVALID_INPUT_FILE : CODE.UPLOAD_FAILED);
      return ok({ imageRefs: r.imageRefs });
    });

  server.registerTool('upload_video',
    {
      title: '上传参考/待编辑视频',
      annotations: { title: '上传参考/待编辑视频', ...SPENDS },
      description: `上传视频,返回 videoRef —— 给 edit_video 当待编辑素材,或给 generate_video_from_refs 当参考视频。` +
        `base64 内联,单个 ≤${effectiveUploadMB}MB、时长 2–60 秒,格式 MP4/MOV。` +
        `更大的文件(手机实拍常超限)请改用 REST:POST /api/video-uploads(multipart,同一把 lj_sk_ 密钥,` +
        `该端点一直在密钥作用域内,不需要额外权限)。` +
        `合规:含真人的视频必须持有被摄主体授权并传 consent=true。`,
      inputSchema: {
        filename: z.string().describe('带扩展名的文件名,如 clip.mp4 —— 扩展名用于判定格式(.mp4/.mov)'),
        data_base64: z.string().describe('视频文件的 base64'),
        consent: z.boolean().describe('已获视频中人物授权;含真人的视频必须为 true'),
      },
    },
    async ({ filename, data_base64, consent }) => {
      const f = decodeUpload(filename, data_base64, {
        mimeMap: VIDEO_MIME, maxBytes: MAX_MEDIA_BYTES, hint: '.mp4/.mov',
      });
      if ('error' in f) return err(f.error, CODE.INVALID_INPUT_FILE);
      const r = await storeVideoInput(
        { tenantId: actor.tenantId, userId: actor.userId, ip: actor.ip ?? null, apiKeyId: actor.apiKeyId },
        f, consent,
      );
      if (!r.ok) return err(r.error, r.status === 400 ? CODE.INVALID_INPUT_FILE : CODE.UPLOAD_FAILED);
      return ok({ videoRef: r.videoRef, duration: r.duration, width: r.width, height: r.height });
    });

  server.registerTool('upload_audio',
    {
      title: '上传参考音频',
      annotations: { title: '上传参考音频', ...SPENDS },
      description: `上传参考音频,返回 audioRef,填进 generate_video_from_refs 的 audioRefs。` +
        `base64 内联,单个 ≤${effectiveUploadMB}MB,格式 MP3/WAV/M4A/AAC。` +
        `更大的文件请改用 REST:POST /api/audio-uploads(multipart,同一把密钥)。` +
        `合规:含真人声音的音频必须持有本人授权并传 consent=true(声纹属个人信息,与图片/视频同一口径)。` +
        `注意:参考音频不是「音色」—— 声音克隆需在灵镜后台创建,API 侧只读(见 list_voices)。`,
      inputSchema: {
        filename: z.string().describe('带扩展名的文件名,如 bgm.mp3(.mp3/.wav/.m4a/.aac)'),
        data_base64: z.string().describe('音频文件的 base64'),
        consent: z.boolean().describe('已获音频中人物授权;含真人声音的音频必须为 true'),
      },
    },
    async ({ filename, data_base64, consent }) => {
      const f = decodeUpload(filename, data_base64, {
        mimeMap: AUDIO_MIME, maxBytes: MAX_MEDIA_BYTES, hint: '.mp3/.wav/.m4a/.aac',
      });
      if ('error' in f) return err(f.error, CODE.INVALID_INPUT_FILE);
      const r = await storeAudioInput(
        { tenantId: actor.tenantId, userId: actor.userId, ip: actor.ip ?? null, apiKeyId: actor.apiKeyId },
        f, consent,
      );
      if (!r.ok) return err(r.error, r.status === 400 ? CODE.INVALID_INPUT_FILE : CODE.UPLOAD_FAILED);
      return ok({ audioRef: r.audioRef });
    });

  // ── 生成 ────────────────────────────────────────────────────────────────
  server.registerTool('generate_image',
    {
      title: '生成图片',
      annotations: { title: '生成图片', ...SPENDS },
      description: '文生图 / 图生图(对应 REST 的 type=ai_image)。' +
        '图生图须先用 upload_image 拿到 imageRefs,再传 mode="img2img" + imageRefs。' +
        '可选模型与分辨率档见 list_models({kind:"image"})。返回 job_id,用 get_job 轮询取结果。',
      inputSchema: {
        prompt: z.string().describe('画面描述'),
        // 不写 .max():每个模型的 maxImages 是超管在后台可改的(image-models 读 DB override),
        // schema 里写死任何数字都会与配置漂 —— 调到 10 张时反而拦住合法请求。
        // 服务端的 clampImageCount 才是单一真相源,超出会截到上限且按截后的张数计费。
        count: z.number().int().min(1).optional()
          .describe('出图张数;超出所选模型的 maxImages 会被截到上限(上限见 list_models)。缺省 1'),
        model: z.string().optional().describe('模型 key,见 list_models({kind:"image"});缺省用平台默认模型'),
        mode: z.enum(['text2img', 'img2img']).optional().describe('缺省 text2img;img2img 必须同时传 imageRefs'),
        imageRefs: z.array(z.string()).optional().describe('upload_image 返回的存储 key,形如 image-inputs/<租户>/<hash>.png'),
        resolution: z.string().optional().describe('清晰度档,见 list_models 的 resolutionTiers / maxResolution'),
        ratio: z.string().optional().describe('画面比例,如 16:9;可选值见 list_models 的 ratios'),
        quality: z.string().optional().describe('画质档(仅按 token 计价的模型,如 gpt-image-2);见 list_models 的 qualities'),
        seed: z.number().int().optional().describe('随机种子,同参数同种子可复现'),
        dry_run: DRY_RUN, idempotency_key: IDEM_KEY,
      },
    },
    async (a) => { const { common, body } = split(a); return runGen(actor, 'ai_image', body, common); });

  server.registerTool('generate_video',
    {
      title: '文字转影片',
      annotations: { title: '文字转影片', ...SPENDS },
      description: '纯文字生成影片(对应 REST 的 type=video_t2v)。' +
        '只有文字、没有参考图时用它;有图请用 generate_video_from_image。' +
        '合法 model / resolution / duration 范围见 list_models({kind:"video"})。' +
        '分钟级异步,返回 job_id,用 get_job 轮询。',
      inputSchema: {
        prompt: z.string().describe('画面描述'),
        model: z.string().optional().describe('模型 key,见 list_models({kind:"video"})'),
        resolution: z.string().optional().describe('分辨率档,如 720P / 1080P;须在该模型的 resolutions 内'),
        duration: z.number().int().optional().describe('时长(秒),须落在该模型的 durationRange 内'),
        ratio: z.string().optional().describe('画面比例,如 16:9'),
        audio: z.boolean().optional().describe('生成有声视频;仅 supportsAudio 的模型可开,否则报错'),
        negativePrompt: z.string().optional().describe('反向提示词(仅 supportsNegative 的模型)'),
        promptExtend: z.boolean().optional().describe('提示词智能改写(仅 supportsPromptExtend 的模型)'),
        seed: z.number().int().optional(),
        dry_run: DRY_RUN, idempotency_key: IDEM_KEY,
      },
    },
    async (a) => { const { common, body } = split(a); return runGen(actor, 'video_t2v', body, common); });

  server.registerTool('generate_video_from_image',
    {
      title: '图片转影片',
      annotations: { title: '图片转影片', ...SPENDS },
      description: '用图片生成影片(对应 REST 的 type=video_i2v)。先用 upload_image 拿 imageRefs。' +
        'task 必填,决定图片怎么用:first_frame=这张图作首帧(传 1 张);' +
        'first_last=首尾帧(传 2 张,顺序即开始图、结束图);reference=参考生成(传 1..maxRefImages 张,prompt 必填且可用 [图1] 指代)。' +
        '各模型支持哪些 task、几张图,见 list_models({kind:"i2v"})。返回 job_id,用 get_job 轮询。',
      inputSchema: {
        task: z.enum(['first_frame', 'first_last', 'reference']).describe('图片的用法;必填,且必须在所选模型的 tasks 内'),
        imageRefs: z.array(z.string()).min(1).describe('upload_image 返回的 key;first_frame 需 1 张、first_last 需 2 张、reference 需 1..maxRefImages 张'),
        prompt: z.string().optional().describe('画面描述;task=reference 时必填(可用 [图1] 指代第 1 张参考图)'),
        model: z.string().optional().describe('模型 key,见 list_models({kind:"i2v"})'),
        resolution: z.string().optional().describe('分辨率档,如 720P / 1080P'),
        duration: z.number().int().optional().describe('时长(秒),须落在该模型的 durationRange 内'),
        ratio: z.string().optional().describe('画面比例;仅 task=reference 且模型声明了 ratios 时生效'),
        audio: z.boolean().optional().describe('生成有声视频;仅 supportsAudio 的模型可开'),
        negativePrompt: z.string().optional(),
        promptExtend: z.boolean().optional(),
        seed: z.number().int().optional(),
        dry_run: DRY_RUN, idempotency_key: IDEM_KEY,
      },
    },
    async (a) => { const { common, body } = split(a); return runGen(actor, 'video_i2v', body, common); });

  server.registerTool('generate_video_from_refs',
    {
      title: '多模态参考生成影片',
      annotations: { title: '多模态参考生成影片', ...SPENDS },
      description: '用文字 + 图片/视频/音频参考的任意组合生成影片(对应 REST 的 type=video_r2v)。' +
        'imageRefs 来自 upload_image、videoRefs 来自 upload_video、audioRefs 来自 upload_audio,三者都可选。' +
        'prompt 里可用 [图1] / [视频1] / [音频1] 指代具体参考。' +
        '唯一的组合限制:不支持「只有音频没有画面来源」——传 audioRefs 时必须同时有 prompt 之外的图或视频。' +
        '各上限(图/视频/音频各几个)见 list_models({kind:"r2v"})。返回 job_id,用 get_job 轮询。',
      inputSchema: {
        prompt: z.string().optional().describe('画面描述;多数参考生模型必填(见 list_models 的 promptRequired)'),
        imageRefs: z.array(z.string()).optional().describe('upload_image 返回的 key,上限见模型 maxRefImages'),
        videoRefs: z.array(z.string()).optional().describe('upload_video 返回的 key,上限见模型 maxVideoRefs'),
        audioRefs: z.array(z.string()).optional().describe('upload_audio 返回的 key,上限见模型 maxAudioRefs'),
        model: z.string().optional().describe('模型 key,见 list_models({kind:"r2v"})'),
        resolution: z.string().optional(),
        duration: z.number().int().optional(),
        ratio: z.string().optional(),
        audio: z.boolean().optional().describe('生成有声视频;仅 supportsAudio 的模型可开(会走有声价档)'),
        seed: z.number().int().optional(),
        dry_run: DRY_RUN, idempotency_key: IDEM_KEY,
      },
    },
    async (a) => { const { common, body } = split(a); return runGen(actor, 'video_r2v', body, common); });

  server.registerTool('edit_video',
    {
      title: '影片编辑',
      annotations: { title: '影片编辑', ...SPENDS },
      description: '编辑已有影片:换装、风格化、局部替换等(对应 REST 的 type=video_edit)。' +
        '先用 upload_video 拿 videoRef。计费按「输入时长 + 预计输出时长」,时长以服务端探测为准(客户端上报无效)。' +
        '各模型的输入时长界、是否支持截断/保留原声,见 list_models({kind:"edit"})。返回 job_id,用 get_job 轮询。',
      inputSchema: {
        videoRef: z.string().describe('upload_video 返回的 key,形如 video-inputs/<租户>/<hash>.mp4'),
        prompt: z.string().optional().describe('编辑指令,如「把外套换成红色风衣」;部分模型必填(见 promptRequired)'),
        model: z.string().optional().describe('模型 key,见 list_models({kind:"edit"})'),
        imageRefs: z.array(z.string()).optional().describe('参考图(upload_image 的 key),上限见模型 maxRefImages'),
        resolution: z.string().optional(),
        ratio: z.string().optional().describe('输出比例;缺省跟随原视频'),
        truncateDuration: z.number().int().min(2).max(10).optional().describe('把输出截断到 N 秒(仅 supportsTruncate 的模型);≥输入时长则忽略'),
        audioSetting: z.enum(['auto', 'origin']).optional().describe('origin=保留原视频声音;缺省 auto'),
        negativePrompt: z.string().optional(),
        promptExtend: z.boolean().optional(),
        seed: z.number().int().optional(),
        dry_run: DRY_RUN, idempotency_key: IDEM_KEY,
      },
    },
    async (a) => { const { common, body } = split(a); return runGen(actor, 'video_edit', body, common); });

  server.registerTool('generate_music',
    {
      title: '生成音乐',
      annotations: { title: '生成音乐', ...SPENDS },
      description: 'AI 音乐生成(对应 REST 的 type=ai_music)。mode 必填:' +
        'song=有人声的歌(prompt 与 lyrics 至少给一个,同时给则以 lyrics 为准,可选 gender);' +
        'instrumental=纯音乐(只能给 prompt,不能给 lyrics/gender)。返回 job_id,用 get_job 轮询。',
      inputSchema: {
        mode: z.enum(['song', 'instrumental']).describe('song=有人声 / instrumental=纯音乐;必填'),
        prompt: z.string().max(2000).optional().describe('音乐风格描述,如「轻快的电子舞曲,适合短视频片头」;≤2000 字符'),
        lyrics: z.string().optional().describe('歌词(仅 mode=song);含中文 5–350 字,纯英文 5–2000 字'),
        gender: z.enum(['male', 'female']).optional().describe('人声性别(仅 mode=song)'),
        model: z.enum(['fun-music-preview', 'fun-music-v1']).optional().describe('音乐模型;缺省用平台默认'),
        dry_run: DRY_RUN, idempotency_key: IDEM_KEY,
      },
    },
    async (a) => { const { common, body } = split(a); return runGen(actor, 'ai_music', body, common); });

  // 情绪/语速/语言的可选值直接从注册表生成 —— 硬编码枚举会与 tts-models.ts 漂,
  // 而 Agent 只信 schema 里写的东西:漂了它就会一直传一个已经不存在的值。
  const emotionKeys = Object.keys(EMOTIONS) as [string, ...string[]];
  const speedKeys = Object.keys(SPEEDS) as [string, ...string[]];
  const languageKeys = Object.keys(LANGUAGES) as [string, ...string[]];
  server.registerTool('generate_speech',
    {
      title: '文字转语音',
      annotations: { title: '文字转语音', ...SPENDS },
      description: 'TTS(对应 REST 的 type=tts)。需 voice_ref —— 先用 list_voices 拿可用音色的 id。' +
        '按字数计费。返回 job_id,用 get_job 轮询。' +
        '注意:创建新音色(声音克隆 / 设计音色)只能在灵镜后台网页端做,API 侧只读。',
      inputSchema: {
        text: z.string().min(1).describe('要合成的文本'),
        voice_ref: z.string().describe('音色 id,来自 list_voices'),
        emotion: z.enum(emotionKeys).optional().describe(`情绪;可选:${emotionKeys.join(' / ')}`),
        rate: z.enum(speedKeys).optional().describe(`语速档;可选:${speedKeys.join(' / ')}`),
        pitch: z.number().int().min(-12).max(12).optional().describe('音高偏移,-12~+12,0 为原声'),
        language: z.enum(languageKeys).optional().describe(`语言;可选:${languageKeys.join(' / ')}`),
        dry_run: DRY_RUN, idempotency_key: IDEM_KEY,
      },
    },
    async (a) => {
      const { common, body } = split(a);
      const { voice_ref, ...rest } = body as { voice_ref: string } & Record<string, unknown>;
      return runGen(actor, 'tts', { ...rest, voiceRef: voice_ref }, common);
    });

  // 过渡别名:dry_run 已经取代它(同一份参数,不会与提交口径分裂)。保留是为了不打断可能已接入的
  // 客户端;内部改走 quoteJob,所以它现在也是严格报价,不再出现「报价过了提交挂了」。
  server.registerTool('estimate',
    {
      title: '费用预估(已废弃)',
      annotations: { title: '费用预估(已废弃)', ...READ_ONLY },
      description: '【已废弃,将在后续版本移除】请改用各 generate_* 工具的 dry_run:true —— ' +
        '那条路与真提交共用同一份参数与同一套校验,不会出现「预估通过但提交失败」。' +
        '本工具的参数是扁平化的,不覆盖 i2v/r2v/edit 的全部字段。',
      inputSchema: {
        type: z.enum(['ai_image', 'video_t2v', 'video_i2v', 'video_r2v', 'video_edit', 'tts', 'ai_music'])
          .describe('任务类型'),
        prompt: z.string().optional(), text: z.string().optional(), count: z.number().int().optional(),
        model: z.string().optional(), resolution: z.string().optional(), duration: z.number().int().optional(),
        mode: z.string().optional(), task: z.string().optional(), videoRef: z.string().optional(),
        imageRefs: z.array(z.string()).optional(), voiceRef: z.string().optional(),
      },
    },
    async (a) => {
      const r = await quoteJob(actor.tenantId, actor.userId, a as Record<string, unknown>);
      return r.ok ? ok({ cost: r.cost, ...(r.extra ?? {}) }) : err(r.error, CODE.INVALID_PARAMS);
    });

  // ── 查询 ────────────────────────────────────────────────────────────────
  server.registerTool('get_job',
    {
      title: '查询任务',
      annotations: { title: '查询任务', ...READ_ONLY },
      description: '按 job_id 查状态。轮询间隔建议 ≥5 秒(视频类是分钟级)。' +
        '完成后 results 里是产物的签名下载 URL(默认 1 小时有效,过期重查即可);失败时 error 是中文可读原因。',
      inputSchema: { job_id: z.string().describe('generate_* 返回的 job_id') },
      outputSchema: {
        job_id: z.string(), status: z.string(), type: z.string(),
        results: z.array(z.string()).optional(), error: z.string().optional(),
      },
    },
    async ({ job_id }) => {
      const job = getJobForTenant(job_id, actor.tenantId, actor.userId);
      if (!job) return err('任务不存在或无权访问', CODE.NOT_FOUND);
      const out: Record<string, unknown> = { job_id: job.id, status: job.status, type: job.type };
      if (job.status === 'done' && job.output_url) {
        try { out.results = await signOutputUrls(job.output_url); } catch { /* 签名失败不阻断状态返回 */ }
      }
      if (job.status === 'failed' && job.error) out.error = job.error;
      return ok(out);
    });

  server.registerTool('list_jobs',
    {
      title: '任务列表',
      annotations: { title: '任务列表', ...READ_ONLY },
      description: '列出本人最近提交的任务(会话重启后找回 job_id 用)。只返回状态与类型,' +
        '不含产物下载链接 —— 拿到 job_id 后用 get_job 取产物。默认 20 条,上限 100。',
      inputSchema: {
        status: z.enum(['queued', 'running', 'done', 'failed']).optional().describe('按状态筛'),
        type: z.string().optional().describe('按任务类型筛,如 ai_image / video_t2v / video_i2v / video_r2v / video_edit / tts / ai_music'),
        limit: z.number().int().min(1).max(100).optional().describe('返回条数,缺省 20,上限 100'),
      },
      outputSchema: {
        jobs: z.array(z.object({
          job_id: z.string(), type: z.string(), status: z.string(),
          created_at: z.number(), error: z.string().optional(),
        })),
      },
    },
    async ({ status, type, limit }) => {
      // actingUserId 必传 —— listJobsForTenant 靠它做账号隔离(同租户其他成员的任务不可见)。
      const rows = listJobsForTenant(actor.tenantId, actor.userId, {
        status, types: type ? [type] : undefined, limit: limit ?? 20,
      });
      return ok({
        jobs: rows.map((j) => ({
          job_id: j.id, type: j.type, status: j.status, created_at: j.created_at,
          ...(j.error ? { error: j.error } : {}),
        })),
      });
    });

  server.registerTool('get_balance',
    {
      title: '查询积分余额',
      annotations: { title: '查询积分余额', ...READ_ONLY },
      description: '返回本机构当前可用积分。余额不足时提交会返回 INSUFFICIENT_CREDITS —— ' +
        '花钱前可以先用它,或直接用 generate_* 的 dry_run(会同时回预估费用和余额)。',
      inputSchema: {},
      outputSchema: { balance: z.number() },
    },
    async () => ok({ balance: balance(actor.tenantId) }));

  // ── 发现 ────────────────────────────────────────────────────────────────
  server.registerTool('list_models',
    {
      title: '模型列表',
      annotations: { title: '模型列表', ...READ_ONLY },
      description: '按用途列可用模型及其能力边界(合法分辨率、时长范围、比例、各类上限、是否支持有声等)。' +
        '生成前先查一次,能避免绝大多数参数错误。' +
        'kind:image=生图 / video=文生影片 / i2v=图转影片 / r2v=参考生成影片 / edit=影片编辑。' +
        '(TTS 没有模型可选;情绪、语速、语言的可选值直接写在 generate_speech 的参数说明里。)',
      inputSchema: { kind: z.enum(['image', 'video', 'i2v', 'r2v', 'edit']).describe('模型用途') },
      // 唯一没有 outputSchema 的查询工具,是有意的:五个 kind 的字段集各不相同(图片有 modes/
      // maxImages,视频有 durationRange/supportsAudio,编辑有 videoDurRange…),硬凑一个并集
      // schema 等于告诉 Agent「这些字段都可能有」,比不声明更误导。字段含义写在 description 里。
    },
    async ({ kind }) => {
      // 与 REST 共用同一批 project* 投影:不泄漏 modelId / provider / priceTier* 等内部计费字段。
      switch (kind) {
        case 'image': return ok({ models: listEnabledImageModels().map(projectImageModel) });
        case 'video': return ok({ models: listVideoModels().filter((d) => d.tasks.length === 0).map(projectT2VModel) });
        case 'i2v': return ok({ models: listI2VModels().map(projectI2VModel) });
        case 'r2v': return ok({ models: listR2VModels().map(projectR2VModel) });
        case 'edit': return ok({ models: listEditModels().map(projectEditModel) });
      }
    });

  server.registerTool('list_voices',
    {
      title: '音色列表',
      annotations: { title: '音色列表', ...READ_ONLY },
      description: '本人可用音色(平台预置 + 自己创建的)。用返回的 id 作 generate_speech 的 voice_ref。' +
        '只有 status="ready" 的音色能用。新建音色(声音克隆 / 设计音色)只能在灵镜后台网页端做。',
      inputSchema: {},
      outputSchema: {
        voices: z.array(z.object({ id: z.string(), name: z.string(), kind: z.string(), status: z.string() })),
      },
    },
    async () => ok({
      voices: [
        ...listVoicePresets().map(projectVoice),
        ...listVoices(actor.tenantId, actor.userId).map(projectVoice),
      ],
    }));

  server.registerTool('list_avatars',
    {
      title: '数字人形象列表',
      annotations: { title: '数字人形象列表', ...READ_ONLY },
      description: '本人可用的数字人形象(平台预置 + 自己创建的)。' +
        '注意:数字人口播视频目前只能在灵镜后台网页端生成,MCP 侧尚未提供对应工具 —— ' +
        '本工具供你确认机构有哪些形象可用,或引导用户去网页端操作。' +
        '要给图片生成影片请用 generate_video_from_image(参考图用 upload_image 上传,与形象无关)。',
      inputSchema: {},
      outputSchema: {
        avatars: z.array(z.object({
          id: z.string(), name: z.string(), kind: z.string(), status: z.string(),
          orientation: z.string().nullable(),
        })),
      },
    },
    async () => ok({
      avatars: [
        ...listAvatarPresets().map((p) => projectAvatar({ ...p, orientation: (p as { orientation?: string }).orientation ?? null })),
        ...listAvatars(actor.tenantId, actor.userId).map(projectAvatar),
      ],
    }));

  return server;
}

/** initialize 时回给 Agent 的全局引导 —— 它会被拼进模型的 system prompt。
 *  这是 MCP 侧最重要的一块「文档」:工具描述只解释单个工具,跨工具的规则(异步口径、先发现再生成、
 *  先问价、重试幂等、合规红线、以及**平台能做但 MCP 做不到的事**)只能写在这里。
 *  最后一条尤其要紧:不写清楚,Agent 会花好几轮去试一个根本不存在的工具。 */
function instructionsFor(uploadMB: number): string {
  return [
    '你正在使用「灵镜」——— 一站式 AIGC 创作平台(影片 / 图片 / 音频)。',
    '',
    '身份与计费:你的密钥等同于某个成员本人,权限、计费、作品归属都和这个人在网页上操作一致。',
    '所有生成都消耗该机构的积分。',
    '',
    '核心工作流(全部异步):',
    '1) 先发现:list_models 拿合法的 model / resolution / duration / 各类上限;',
    '   list_voices 拿 generate_speech 需要的 voice_ref。凭空猜参数是最常见的失败原因。',
    '2) 要用参考素材就先上传:upload_image / upload_video / upload_audio,拿到 ref 再填进生成工具。',
    '3) 不确定花多少钱,先用 dry_run: true —— 它与真提交共用同一套校验,通过即代表同参数提交也能通过,',
    '   并会一并返回当前余额。',
    '4) generate_* 返回 job_id(不是成品),用 get_job 轮询;轮询间隔 ≥5 秒,视频类通常要几分钟。',
    '5) 会话中断后用 list_jobs 找回之前的 job_id。',
    '',
    '重试:网络超时后重试同一次请求,请带上相同的 idempotency_key,否则会重复扣费、重复生成。',
    '想再要一份(哪怕参数完全一样)请换一个新的 idempotency_key。',
    '',
    '错误处理:错误都带机器可读的 code。INVALID_PARAMS / INVALID_INPUT_FILE / NOT_FOUND /',
    'PAYLOAD_TOO_LARGE / ROLE_FORBIDDEN / INSUFFICIENT_CREDITS / IDEMPOTENCY_CONFLICT 重试没有意义 ——',
    '请改参数、换一个 idempotency_key,或告知用户充值;',
    '只有 RATE_LIMITED 和 UPLOAD_FAILED 值得指数退避后重试。',
    '',
    '合规红线(不可绕过):含真人的图片 / 视频 / 音频都必须持有被摄主体或本人授权,上传时传 consent=true,',
    '责任主体是调用方机构。生成内容受平台审核约束 —— 审核拒绝不在提交时报错,而是任务落为 failed,',
    '原因在 get_job 的 error 字段里。',
    '',
    `大文件:MCP 走 JSON 内联,单个素材上限约 ${uploadMB}MB。手机实拍视频常常超限,`,
    '这时请改用 REST(同一把 lj_sk_ 密钥,已在作用域内,不需要额外权限):',
    '  curl -X POST https://<你的域名>/api/video-uploads \\',
    '    -H "Authorization: Bearer lj_sk_..." -F consent=true -F video=@clip.mp4',
    '拿到返回的 videoRef 后照常填进 edit_video / generate_video_from_refs。',
    '',
    '本接口做不到、只能在灵镜后台网页端完成的事(不要尝试用工具实现,请直接告诉用户):',
    '- 数字人口播视频(照片/形象 + 文案 → 对口型视频)',
    '- 创建数字人形象(需上传素材并完成授权存证)',
    '- 声音克隆 / 设计音色(需授权存证)',
    'list_avatars / list_voices 只能读取已有的形象与音色。',
  ].join('\n');
}

export const mcpRouter = Router();

// 认证结果挂 req,供 body parser 之后的处理器复用(不重复查库)。
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      mcpKey?: { user: AuthedUser; keyId: string };
    }
  }
}

// ── 鉴权 + 粗粒度限速前置(必须在 body parser 之前)──
// upload_* 把 /mcp 的 body 上限从全局 1mb 提到 32mb。若鉴权仍留在 parser 之后,任何**匿名**
// 请求都能让进程先缓冲 32MB 再被 401 拒掉 —— 32 倍的免鉴权内存放大,20 个并发就是 640MB,
// 且 parser 之后的限速器根本够不着。resolveApiKeyFull 只读 Authorization 头、不需要 body,
// 所以前移零成本。粗闸取两档上限中较宽的读档(300/min):任何能过精确闸的请求必然能过粗闸,
// 不误伤;但把「解析前」的缓冲量从无界压到 300×上限/分钟/密钥。精确的读写分级仍在 parser 之后。
const preParseLimiter = new SlidingWindowLimiter(60_000, Math.max(READ_PER_MIN, WRITE_PER_MIN));
mcpRouter.use((req: Request, res: Response, next: NextFunction) => {
  const viaKey = resolveApiKeyFull(req.headers.authorization);
  if (!viaKey) {
    res.status(401).json({ error: '密钥无效或未提供', code: CODE.UNAUTHORIZED });
    return;
  }
  // 防御纵深,正常不可达:角色已精简为 admin/creator(db/index.ts 有 viewer→creator 的迁移),
  // 但 user.role 列**没有 CHECK 约束** —— 手工改库或将来新增只读角色时,这道闸决定了
  // 「未知角色」默认是拒绝而不是放行。别因为「现在跑不到」就删掉:删掉的那天默认就反了。
  if (viaKey.user.role !== 'admin' && viaKey.user.role !== 'creator') {
    res.status(403).json({ error: '该角色的密钥不能发起生成', code: CODE.ROLE_FORBIDDEN });
    return;
  }
  if (!preParseLimiter.allow(viaKey.keyId)) {
    res.status(429).json({ error: '请求过于频繁,请稍后重试', code: CODE.RATE_LIMITED });
    return;
  }
  req.mcpKey = viaKey;
  next();
});

// ── body 上限解析(要放在字节闸之前:闸子拿它给未声明长度的请求记账,并据此定人头上限)──
const RAW_BODY_LIMIT = process.env.MCP_BODY_LIMIT || '';
const MCP_BODY_LIMIT = /^\d+(\.\d+)?(b|kb|mb|gb)$/i.test(RAW_BODY_LIMIT) ? RAW_BODY_LIMIT : '32mb';
if (RAW_BODY_LIMIT && RAW_BODY_LIMIT !== MCP_BODY_LIMIT) {
  console.warn(`[MCP] MCP_BODY_LIMIT="${RAW_BODY_LIMIT}" 格式非法(应形如 32mb),已回落 ${MCP_BODY_LIMIT}`);
}
// 单个素材的**有效**上限 = min(工具自己的 20MB, body 上限 × 0.75)。运维把 MCP_BODY_LIMIT 调小时,
// 工具描述里写死的 "20MB" 就成了假话 —— Agent 会照着 20MB 传然后吃 413,且不知道为什么。
// 故算出来写进 description 与 instructions,不写字面量。
const BODY_LIMIT_BYTES = ((): number => {
  const m = /^(\d+(?:\.\d+)?)(b|kb|mb|gb)$/i.exec(MCP_BODY_LIMIT);
  const unit = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[(m?.[2] || 'mb').toLowerCase()]!;
  return Math.round(Number(m?.[1] ?? 32) * unit);
})();
const EFFECTIVE_UPLOAD_MB = Math.max(1, Math.floor(Math.min(MAX_MEDIA_BYTES, BODY_LIMIT_BYTES * 0.75) / (1024 * 1024)));

// ── 并发在飞字节闸(必须也在 parser 之前)──
// 上面的粗闸管的是**频率**(次/分钟),管不了**同时有多少字节在内存里**。加了两条 20MB 上传路径后,
// 单个已鉴权请求的常态足迹就是几十 MB;速率闸允许 300 次/分钟/密钥,完全放得下十几路并发大上传
// 同时在飞 —— 那是几百 MB 的瞬时占用,而且 parser 一旦开始缓冲就来不及了。
// 这里按 Content-Length 在解析前记账,超过总量直接 429 + Retry-After(可退避,语义正确)。
// 注:Content-Length 由客户端提供,可能撒谎 —— 但 express.json 的 limit 仍在后面兜底单请求上限,
// 本闸要挡的是「诚实但太多」的并发,不是单个恶意请求。
const MCP_INFLIGHT_BYTES = ((): number => {
  const raw = process.env.MCP_INFLIGHT_BYTES || '';
  const m = /^(\d+(?:\.\d+)?)(mb|gb)$/i.exec(raw.trim());
  if (!m) {
    if (raw) console.warn(`[MCP] MCP_INFLIGHT_BYTES="${raw}" 格式非法(应形如 128mb),已回落 128mb`);
    return 128 * 1024 * 1024;
  }
  return Math.round(Number(m[1]) * (m[2]!.toLowerCase() === 'gb' ? 1024 ** 3 : 1024 ** 2));
})();
let inflightBytes = 0;
// 除了全局预算,还要一道**每密钥**上限。原因是上面那条「未声明长度按 body 上限记账」的
// 保守修法自带一个副作用:一个 chunked 请求无论实际多小都按 32mb 记 —— 128mb 全局预算
// 只够四个。计数器又是进程全局、不分租户,Node 默认 requestTimeout 还有 300 秒,
// 于是任一客户开四条 chunked 连接慢慢吐字节,就能把**全平台**的 /mcp 堵死五分钟,
// 而两道速率闸都看不见(它们数的是「几次」,不是「同时占了多少」)。
// 加人头闸后爆炸半径从「全平台」缩到「该密钥自己」。配套的 requestTimeout 见 server.ts。
const perKeyInflight = new Map<string, number>();
// 下界必须是 body 上限:低于它,一个**完全合法的满尺寸请求**就永远发不出去 ——
// 闸子在拦自己允许的东西。所以取 max(body 上限, 全局/4):
//   · 默认配置(32mb body / 128mb 全局)→ 32mb,单密钥同时只占得下一个满尺寸请求;
//     那正是要挡的场景(四条 chunked 吃满全局),而合法的大上传不受影响。
//   · 全局预算调得比 body 上限还小时,人头闸自然失效、由全局闸兜底(配置本身不自洽)。
const PER_KEY_INFLIGHT_MAX = Math.max(BODY_LIMIT_BYTES, Math.floor(MCP_INFLIGHT_BYTES / 4));
mcpRouter.use((req: Request, res: Response, next: NextFunction) => {
  // Content-Length 缺失(Transfer-Encoding: chunked)时**按 body 上限记账**,不能当 0。
  // 实测过:算 0 的话十路并发 26.7MB 的 chunked 上传全部放行,同样字节带 Content-Length 则被拦 ——
  // 一行客户端配置就能让整道闸形同虚设。方向必须保守:宁可多算(chunked 小请求占满额度、
  // 预算紧时被 429 退避),不可少算(免费绕过)。
  const declared = Number(req.headers['content-length']);
  const len = Number.isFinite(declared) && declared > 0 ? declared : BODY_LIMIT_BYTES;
  const keyId = req.mcpKey!.keyId; // 前置鉴权中间件保证非空
  const mine = perKeyInflight.get(keyId) ?? 0;
  if (inflightBytes + len > MCP_INFLIGHT_BYTES || mine + len > PER_KEY_INFLIGHT_MAX) {
    res.set('Retry-After', '2').status(429).json({
      error: '服务端上传通道繁忙(并发数据量已达上限),请退避 2 秒后重试',
      code: CODE.RATE_LIMITED,
    });
    return;
  }
  inflightBytes += len;
  perKeyInflight.set(keyId, mine + len);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    inflightBytes -= len;
    const left = (perKeyInflight.get(keyId) ?? len) - len;
    // 归零就删键,否则 Map 会随密钥数无限长(每把用过的密钥留一个 0 条目)
    if (left > 0) perKeyInflight.set(keyId, left); else perKeyInflight.delete(keyId);
  };
  res.on('close', release);
  res.on('finish', release);
  next();
});

// 自带 body parser(挂在全局 express.json 之前,见 server.ts):upload_* 走 base64 内联,
// 全局 1mb 上限会把参考图打成 413。上限可经 env 覆盖(私有化按机器内存调)。
// 注:base64 比原始字节大 ~33%,故 32mb 约等于 24MB 原始文件。
// 格式必须校验:body-parser 用 bytes.parse(),解析不出的值返回 null = **不设上限**,
// 一个 env 里的错别字就会静默关掉整个上限闸,而不是报错。宁可回落默认。
mcpRouter.use(express.json({ limit: MCP_BODY_LIMIT }));
// 超限兜底:express.json 默认抛 HTML 错误页,Agent 拿到一坨 HTML 只能瞎猜。
// 转成明确的 JSON + 可执行建议。文案不能只说「减少图片张数」—— 视频上传本来就只有一个文件,
// 那句建议对它是错的,会把 Agent 引到死路上。
mcpRouter.use((e: unknown, _req: Request, res: Response, next: NextFunction) => {
  const type = (e as { type?: string } | null)?.type;
  if (type === 'entity.too.large') {
    res.status(413).json({
      error: `请求体超过上限(${MCP_BODY_LIMIT},约合 ${EFFECTIVE_UPLOAD_MB}MB 原始文件)。` +
        `图片可减少单次张数或压缩;视频/音频请改用 REST 上传端点(POST /api/video-uploads · /api/audio-uploads,multipart,同一把密钥)。`,
      code: CODE.PAYLOAD_TOO_LARGE,
    });
    return;
  }
  // 请求体解析失败也必须回 JSON。app 没有全局错误中间件,漏到 express 默认处理器就是一张
  // **HTML 错误页** —— Agent 拿到一坨 HTML 只能瞎猜,和 413 当初要修的是同一个病。
  // 触发场景很实在:客户端库拼 JSON 出错、代理截断了请求体、编码不是 UTF-8。
  if (type === 'entity.parse.failed' || type === 'encoding.unsupported' || e instanceof SyntaxError) {
    res.status(400).json({
      error: '请求体不是合法的 JSON(可能被截断或编码有误),请检查后重发。MCP 端点只接受 UTF-8 JSON-RPC。',
      code: CODE.INVALID_PARAMS,
    });
    return;
  }
  next(e);
});

// stateless:认证/粗闸/字节闸已在 parser 前置中间件完成 → 精确读写限速 → 新建 server+transport → handleRequest。
mcpRouter.post('/', async (req: Request, res: Response) => {
  const viaKey = req.mcpKey!; // 前置中间件保证非空(不通过者已被 401/403/429 拦下)
  // 只给 /mcp 设请求超时(不全局设:REST 侧的 100MB 上传合法地要跑 80–160 秒)。
  // 这里的请求体上限是 32mb 且已被并发字节闸记账,一条卡住的连接会一直占着那份额度 ——
  // Node 默认 300 秒太长,60 秒足够任何一次内联上传。
  req.setTimeout(60_000);
  // ── 限速分档 ──
  // 两件事必须同时做对,漏一件就等于没有写限速:
  //
  // ① 按**工具**分,不能只按 JSON-RPC method 分。get_job / list_jobs / get_balance / list_*
  //    也都是 tools/call,但它们是读 —— 而 instructions 恰恰叫 Agent 每 5 秒轮一次 get_job。
  //    全算写的话,盯 5 个视频任务光轮询就吃满 60/min 的生成配额,一次生成都发不出去。
  //
  // ② **JSON-RPC 允许 body 是数组(batch)**,而我们用的 transport 确实会逐条派发
  //    (streamableHttp 内部包的是 WebStandardStreamableHTTPServerTransport,它 Array.isArray 后循环)。
  //    数组上取 body.method 是 undefined —— 只按单条对象分类的话,一个装了 N 条 generate_* 的
  //    数组会被判成「一次读」放行,然后在里面跑 N 次真实提交:写限速形同虚设,余额可被一口气抽干,
  //    事件循环被钉住(worker 同进程)。而且 stateless 下不需要先 initialize 就能打。
  //    所以:逐条分类、逐条计数,并给批量长度设硬上限。
  const raw = req.body as unknown;
  const msgs: { method?: string; params?: { name?: string } }[] =
    Array.isArray(raw) ? raw as { method?: string; params?: { name?: string } }[]
      : [ (raw ?? {}) as { method?: string; params?: { name?: string } } ];
  if (msgs.length > MAX_BATCH_MESSAGES) {
    res.status(413).json({
      error: `单次请求最多 ${MAX_BATCH_MESSAGES} 条 JSON-RPC 消息,请拆分后重发`,
      code: CODE.PAYLOAD_TOO_LARGE,
    });
    return;
  }
  const isWriteMsg = (m: { method?: string; params?: { name?: string } }): boolean => {
    if ((m?.method ?? '') !== 'tools/call') return false;
    const name = m?.params?.name;
    // 取不到工具名(畸形/缺失)时算写:保守方向,宁可严不可松。
    return !(typeof name === 'string' && READ_ONLY_TOOL_NAMES.has(name));
  };
  for (const m of msgs) {
    const limiter = isWriteMsg(m) ? writeLimiter : readLimiter;
    if (!limiter.allow(viaKey.keyId)) {
      res.status(429).json({ error: '请求过于频繁,请稍后重试', code: CODE.RATE_LIMITED });
      return;
    }
  }

  const actor: SubmitActor = {
    tenantId: viaKey.user.tenantId, userId: viaKey.user.id, role: viaKey.user.role,
    // 取真实客户端 IP。此前写死 null,导致**整个 Agent 面**的审计行与授权存证都没有来源 ——
    // 而这恰恰是最需要溯源的一面(密钥可能泄漏、调用方不是本人在操作)。
    // app 已配 trust proxy,clientIpOf 与 REST 侧同一口径。
    ip: clientIpOf(req), apiKeyId: viaKey.keyId,
    channel: 'mcp', // 此端点只服务 MCP → 提交的 job 标 mcp,记录卡显「MCP 创建」
  };
  const server = buildMcpServer(actor, EFFECTIVE_UPLOAD_MB);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }); // stateless
  res.on('close', () => { transport.close(); server.close(); });
  // 必须包 try/catch:express 4 不捕获 async handler 的拒绝,漏出去就是 unhandledRejection,
  // 而 Node 默认对它 **退出进程** —— 本进程同时跑着 worker(server.ts 里 startWorker),
  // 一个客户端中途断开就能把全平台在跑的生成任务一起带走。
  // 触发路径不假设:res.on('close') 在两个 await 之前就注册了,客户端 abort 会先 close 掉
  // transport,随后的 connect/handleRequest 就在一个已关闭的 transport 上操作。
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error('[MCP] handleRequest 失败', e);
    if (!res.headersSent) {
      res.status(500).json({ error: '服务端内部错误,请稍后重试', code: CODE.INTERNAL_ERROR });
    }
  }
});
