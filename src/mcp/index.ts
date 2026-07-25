// 灵镜 Open API — MCP server(设计文档 §5,PR2)。
//
// 面向 Claude Code / Cursor 等 Agent 的原生接入。stateless Streamable HTTP:每请求新建
// transport + server(无会话,重启无状态丢失,外部声音 #8)。同一把 lj_sk_ 密钥认证 + 同款读写限速。
// 工具直接调 submitJob() / estimateJob() / 模型&发现函数(不 HTTP 自调用,D4)。
//
// 全工具异步口径(D9):generate_* 提交即返 job_id,get_job 取结果 —— Agent 端一套逻辑,无悬挂。
// 挂载:在全局 attachUser / requireApiScope 之前独立挂 /mcp(自带认证,不进 /api 中间件栈,同 /admin 隔离)。

import type { NextFunction, Request, Response } from 'express';
import express, { Router } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { resolveApiKeyFull } from '../auth/api-keys.js';
import type { AuthedUser } from '../auth/index.js';
import { SlidingWindowLimiter } from '../auth/rate-limit.js';
import { submitJob, estimateJob, storeImageInputs, type SubmitActor, type UploadFile } from '../api/jobs.js';
import { getJobForTenant } from '../queue/index.js';
import { signOutputUrls } from '../storage/index.js';
import { listEnabledModels } from '../gateway/image-models.js';
import { listVideoModels, listI2VModels, listR2VModels, listEditModels } from '../gateway/video-models.js';
import { listCustom as listAvatars, listPresets as listAvatarPresets } from '../avatars/index.js';
import { listClones as listVoices, listPresets as listVoicePresets } from '../voices/index.js';

// 限速:与 REST 同口径(写 60/min、读 300/min per key)。MCP 的 tools/call 生成算写,其余算读。
const WRITE_PER_MIN = Number(process.env.API_RATE_WRITE_PER_MIN) || 60;
const READ_PER_MIN = Number(process.env.API_RATE_READ_PER_MIN) || 300;
const writeLimiter = new SlidingWindowLimiter(60_000, WRITE_PER_MIN);
const readLimiter = new SlidingWindowLimiter(60_000, READ_PER_MIN);

type ToolText = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
const ok = (data: Record<string, unknown>): ToolText => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
const err = (message: string, code?: string): ToolText => ({ content: [{ type: 'text', text: message }], structuredContent: code ? { error: message, code } : { error: message }, isError: true });

/** 提交类工具的公共收尾:submitJob → {job_id, cost, status} 或错误(透传中文 error + code)。 */
async function submitAndReport(actor: SubmitActor, body: Record<string, unknown>, idempotencyKey?: string): Promise<ToolText> {
  const r = await submitJob(actor, body, idempotencyKey);
  if (!r.ok) return err(r.error, r.code);
  return ok({ job_id: r.id, status: r.status, cost: r.cost, reused: r.reused });
}

// ── base64 → UploadFile ──
// MCP 是 JSON-RPC,没有 multipart。Agent 手里是本地文件,故走 base64 内联(见 /mcp 的 body limit)。
// base64 不带 MIME,由扩展名推断 —— 推不出的扩展名直接交给 storeImageInputs 的格式白名单拒掉,
// 不猜、不放行:格式校验是深度合成合规链的一环,宁可报错也不能误判成 image/jpeg 放过去。
const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', gif: 'image/gif',
};
// anyExt:授权凭证用。凭证可能是 PDF/扫描件,不该被图片扩展名白名单误杀 —— 认不出扩展名时
// 回落 octet-stream 存下,而不是拒收(误杀会把整条合规上传挡死)。图片本身永远不走这条。
function decodeUpload(filename: string, base64: string, opts?: { anyExt?: boolean }): UploadFile | { error: string } {
  // 容错:Agent 常直接贴 data URL(data:image/png;base64,xxx),剥掉前缀再解;顺带去掉换行。
  const raw = base64.replace(/^data:[^;]*;base64,/, '').replace(/\s/g, '');
  if (!raw) return { error: `${filename}:内容为空` };
  // 先按 base64 长度估字节数,超限即拒 —— 不先解出 buffer 再判,避免为一张超大图白吃内存。
  if (raw.length * 3 / 4 > 10 * 1024 * 1024) return { error: `${filename}:单个文件不能超过 10MB` };
  const buffer = Buffer.from(raw, 'base64');
  if (buffer.length === 0) return { error: `${filename}:base64 解码失败` };
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const mimetype = EXT_MIME[ext] ?? (opts?.anyExt ? 'application/octet-stream' : undefined);
  if (!mimetype) return { error: `${filename}:无法识别的图片扩展名,请用 .jpg/.png/.webp/.bmp/.tiff/.gif` };
  return { buffer, mimetype, originalname: filename, size: buffer.length };
}

/** 为某个已认证 actor 构建一台 MCP server(工具闭包绑定其身份 + key id)。 */
function buildMcpServer(actor: SubmitActor): McpServer {
  const server = new McpServer({ name: 'lingjing', version: '0.7.0' });

  // 图生图闭环的第一步。缺了它,generate_image 的 imageRefs 参数在 MCP 侧无从填充 ——
  // Agent 只能瞎猜路径、撞上作用域 403,再误判成「密钥权限不足」(v0.8.0.7 修的就是这个)。
  server.registerTool('upload_image',
    {
      title: '上传参考图',
      description: '上传图生图/图转影片的输入图,返回 imageRefs(存储 key),直接填进 generate_image 的 imageRefs。' +
        '图片用 base64 内联,单张 ≤10MB、一次 ≤9 张,格式 JPG/PNG/WEBP/BMP/TIFF/GIF(不支持 HEIC)。' +
        '合规:含真人的图必须持有被摄主体授权并传 consent=true(与网页端同一口径,责任主体为你的机构)。' +
        '注意:这不是「数字人形象」——形象只用于口播视频,需在灵镜后台创建,API 侧只读(见 list_avatars)。',
      inputSchema: {
        images: z.array(z.object({
          filename: z.string().describe('带扩展名的文件名,如 ref.png —— 扩展名用于判定格式'),
          data_base64: z.string().describe('图片文件的 base64(可直接贴 data:image/png;base64,… 形式)'),
        })).min(1).max(9),
        consent: z.boolean().describe('已获图中人物授权;含真人的图必须为 true'),
        proof: z.object({ filename: z.string(), data_base64: z.string() }).optional().describe('授权凭证文件(可选存证)'),
      },
    },
    async ({ images, consent, proof }) => {
      const files: UploadFile[] = [];
      for (const im of images) {
        const f = decodeUpload(im.filename, im.data_base64);
        if ('error' in f) return err(f.error, 'INVALID_IMAGE');
        files.push(f);
      }
      let proofFile: UploadFile | undefined;
      if (proof) {
        const p = decodeUpload(proof.filename, proof.data_base64, { anyExt: true });
        if ('error' in p) return err(`授权凭证:${p.error}`, 'INVALID_IMAGE');
        proofFile = p;
      }
      const r = await storeImageInputs(
        { tenantId: actor.tenantId, userId: actor.userId, ip: actor.ip ?? null, apiKeyId: actor.apiKeyId },
        files, consent, proofFile,
      );
      if (!r.ok) return err(r.error, r.status === 400 ? 'INVALID_REQUEST' : 'UPLOAD_FAILED');
      return ok({ imageRefs: r.imageRefs });
    });

  server.registerTool('generate_image',
    { title: '生成图片', description: '文生图 / 图生图。图生图须先用 upload_image 拿到 imageRefs,再传 mode="img2img" + imageRefs。返回 job_id,用 get_job 轮询取结果。', inputSchema: { prompt: z.string(), count: z.number().int().min(1).optional(), model: z.string().optional(), mode: z.enum(['text2img', 'img2img']).optional(), imageRefs: z.array(z.string()).optional().describe('upload_image 返回的存储 key,形如 image-inputs/<租户>/<uuid>.png') } },
    async (a) => submitAndReport(actor, { type: 'ai_image', ...a }));

  server.registerTool('generate_video',
    { title: '生成视频', description: '文字转影片。返回 job_id(分钟级异步),用 get_job 轮询。', inputSchema: { prompt: z.string(), model: z.string().optional(), resolution: z.string().optional(), duration: z.number().int().optional() } },
    async (a) => submitAndReport(actor, { type: 'video_t2v', ...a }));

  server.registerTool('generate_music',
    { title: '生成音乐', description: 'AI 音乐生成。返回 job_id,用 get_job 轮询。', inputSchema: { prompt: z.string() } },
    async (a) => submitAndReport(actor, { type: 'ai_music', ...a }));

  server.registerTool('generate_speech',
    { title: '文字转语音', description: 'TTS。需 voice_ref(见 list_voices)。返回 job_id,用 get_job 轮询。', inputSchema: { text: z.string(), voice_ref: z.string() } },
    async (a) => submitAndReport(actor, { type: 'tts', text: a.text, voiceRef: a.voice_ref }));

  server.registerTool('get_job',
    { title: '查询任务', description: '按 job_id 查状态;完成后含产物签名下载 URL(默认 1h 有效,过期重查即可)。', inputSchema: { job_id: z.string() } },
    async ({ job_id }) => {
      const job = getJobForTenant(job_id, actor.tenantId, actor.userId);
      if (!job) return err('任务不存在或无权访问', 'NOT_FOUND');
      const out: Record<string, unknown> = { job_id: job.id, status: job.status, type: job.type };
      if (job.status === 'done' && job.output_url) {
        try { out.results = await signOutputUrls(job.output_url); } catch { /* 签名失败不阻断状态返回 */ }
      }
      if (job.status === 'failed' && job.error) out.error = job.error;
      return ok(out);
    });

  server.registerTool('list_models',
    { title: '模型列表', description: '按 kind 列可用模型(image/video/i2v/r2v/edit)。', inputSchema: { kind: z.enum(['image', 'video', 'i2v', 'r2v', 'edit']) } },
    async ({ kind }) => {
      const map = { image: listEnabledModels, video: listVideoModels, i2v: listI2VModels, r2v: listR2VModels, edit: listEditModels } as const;
      return ok({ models: map[kind]() as unknown as unknown[] });
    });

  server.registerTool('list_voices',
    { title: '音色列表', description: '本人可用音色(预置 + 自己创建的);用其 ref 作 generate_speech 的 voice_ref。', inputSchema: {} },
    async () => ok({ voices: [...listVoicePresets(), ...listVoices(actor.tenantId, actor.userId)] as unknown as unknown[] }));

  server.registerTool('list_avatars',
    { title: '形象列表', description: '本人可用数字人形象(预置 + 自己创建的)。', inputSchema: {} },
    async () => ok({ avatars: [...listAvatarPresets(), ...listAvatars(actor.tenantId, actor.userId)] as unknown as unknown[] }));

  server.registerTool('estimate',
    { title: '费用预估', description: '提交前预估扣费(参数同 generate_*,加 type)。', inputSchema: { type: z.string(), prompt: z.string().optional(), text: z.string().optional(), count: z.number().int().optional(), model: z.string().optional(), resolution: z.string().optional(), duration: z.number().int().optional() } },
    async (a) => {
      const r = await estimateJob(actor.tenantId, a as Record<string, unknown>);
      return r.ok ? ok({ cost: r.cost, ...(r.extra ?? {}) }) : err(r.error);
    });

  return server;
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
// upload_image 把 /mcp 的 body 上限从全局 1mb 提到 32mb。若鉴权仍留在 parser 之后,任何**匿名**
// 请求都能让进程先缓冲 32MB 再被 401 拒掉 —— 32 倍的免鉴权内存放大,20 个并发就是 640MB,
// 且 parser 之后的限速器根本够不着。resolveApiKeyFull 只读 Authorization 头、不需要 body,
// 所以前移零成本。粗闸取两档上限中较宽的读档(300/min):任何能过精确闸的请求必然能过粗闸,
// 不误伤;但把「解析前」的缓冲量从无界压到 300×上限/分钟/密钥。精确的读写分级仍在 parser 之后。
const preParseLimiter = new SlidingWindowLimiter(60_000, Math.max(READ_PER_MIN, WRITE_PER_MIN));
mcpRouter.use((req: Request, res: Response, next: NextFunction) => {
  const viaKey = resolveApiKeyFull(req.headers.authorization);
  if (!viaKey) {
    res.status(401).json({ error: '密钥无效或未提供', code: 'UNAUTHORIZED' });
    return;
  }
  if (viaKey.user.role !== 'admin' && viaKey.user.role !== 'creator') {
    res.status(403).json({ error: 'viewer 密钥不能发起生成', code: 'ROLE_FORBIDDEN' });
    return;
  }
  if (!preParseLimiter.allow(viaKey.keyId)) {
    res.status(429).json({ error: '请求过于频繁,请稍后重试', code: 'RATE_LIMITED' });
    return;
  }
  req.mcpKey = viaKey;
  next();
});

// 自带 body parser(挂在全局 express.json 之前,见 server.ts):upload_image 走 base64 内联,
// 全局 1mb 上限会把参考图打成 413。上限可经 env 覆盖(私有化按机器内存调)。
// 注:base64 比原始字节大 ~33%,故 32mb 约等于 24MB 原图 —— 单张 10MB 上限下够传满 2 张 + 富余。
// 格式必须校验:body-parser 用 bytes.parse(),解析不出的值返回 null = **不设上限**,
// 一个 env 里的错别字就会静默关掉整个上限闸,而不是报错。宁可回落默认。
const RAW_BODY_LIMIT = process.env.MCP_BODY_LIMIT || '';
const MCP_BODY_LIMIT = /^\d+(\.\d+)?(b|kb|mb|gb)$/i.test(RAW_BODY_LIMIT) ? RAW_BODY_LIMIT : '32mb';
if (RAW_BODY_LIMIT && RAW_BODY_LIMIT !== MCP_BODY_LIMIT) {
  console.warn(`[MCP] MCP_BODY_LIMIT="${RAW_BODY_LIMIT}" 格式非法(应形如 32mb),已回落 ${MCP_BODY_LIMIT}`);
}
mcpRouter.use(express.json({ limit: MCP_BODY_LIMIT }));
// 超限兜底:express.json 默认抛 HTML 错误页,Agent 拿到一坨 HTML 只能瞎猜。
// 转成明确的 JSON + 可执行建议(减张数 / 压缩),这是 Agent 唯一能读懂的东西。
mcpRouter.use((e: unknown, _req: Request, res: Response, next: NextFunction) => {
  if ((e as { type?: string } | null)?.type === 'entity.too.large') {
    res.status(413).json({
      error: `请求体超过上限(${MCP_BODY_LIMIT})。请减少单次 upload_image 的图片张数,或先压缩图片再传。`,
      code: 'PAYLOAD_TOO_LARGE',
    });
    return;
  }
  next(e);
});

// stateless:认证/粗闸已在 parser 前置中间件完成 → 精确读写限速 → 新建 server+transport → handleRequest。
mcpRouter.post('/', async (req: Request, res: Response) => {
  const viaKey = req.mcpKey!; // 前置中间件保证非空(不通过者已被 401/403/429 拦下)
  // tools/call 走写限速,其余(initialize/tools/list)走读限速。best-effort 从 body 判定 method。
  const method = (req.body as { method?: string } | undefined)?.method ?? '';
  const limiter = method === 'tools/call' ? writeLimiter : readLimiter;
  if (!limiter.allow(viaKey.keyId)) {
    res.status(429).json({ error: '请求过于频繁,请稍后重试', code: 'RATE_LIMITED' });
    return;
  }

  const actor: SubmitActor = {
    tenantId: viaKey.user.tenantId, userId: viaKey.user.id, role: viaKey.user.role,
    ip: null, apiKeyId: viaKey.keyId,
    channel: 'mcp', // 此端点只服务 MCP → 提交的 job 标 mcp,记录卡显「MCP 创建」
  };
  const server = buildMcpServer(actor);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }); // stateless
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
