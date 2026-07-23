// 灵镜 Open API — MCP server(设计文档 §5,PR2)。
//
// 面向 Claude Code / Cursor 等 Agent 的原生接入。stateless Streamable HTTP:每请求新建
// transport + server(无会话,重启无状态丢失,外部声音 #8)。同一把 lj_sk_ 密钥认证 + 同款读写限速。
// 工具直接调 submitJob() / estimateJob() / 模型&发现函数(不 HTTP 自调用,D4)。
//
// 全工具异步口径(D9):generate_* 提交即返 job_id,get_job 取结果 —— Agent 端一套逻辑,无悬挂。
// 挂载:在全局 attachUser / requireApiScope 之前独立挂 /mcp(自带认证,不进 /api 中间件栈,同 /admin 隔离)。

import type { Request, Response } from 'express';
import { Router } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { resolveApiKeyFull } from '../auth/api-keys.js';
import { SlidingWindowLimiter } from '../auth/rate-limit.js';
import { submitJob, estimateJob, type SubmitActor } from '../api/jobs.js';
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

/** 为某个已认证 actor 构建一台 MCP server(工具闭包绑定其身份 + key id)。 */
function buildMcpServer(actor: SubmitActor): McpServer {
  const server = new McpServer({ name: 'lingjing', version: '0.7.0' });

  server.registerTool('generate_image',
    { title: '生成图片', description: '文生图 / 图生图。返回 job_id,用 get_job 轮询取结果。', inputSchema: { prompt: z.string(), count: z.number().int().min(1).optional(), model: z.string().optional(), mode: z.enum(['text2img', 'img2img']).optional(), imageRefs: z.array(z.string()).optional() } },
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
      const job = getJobForTenant(job_id, actor.tenantId, actor.userId, actor.role === 'admin');
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
    { title: '音色列表', description: '本机构可用音色(含预置);用其 ref 作 generate_speech 的 voice_ref。', inputSchema: {} },
    async () => ok({ voices: [...listVoicePresets(), ...listVoices(actor.tenantId, actor.userId, actor.role === 'admin')] as unknown as unknown[] }));

  server.registerTool('list_avatars',
    { title: '形象列表', description: '本机构可用数字人形象(含预置)。', inputSchema: {} },
    async () => ok({ avatars: [...listAvatarPresets(), ...listAvatars(actor.tenantId, actor.userId, actor.role === 'admin')] as unknown as unknown[] }));

  server.registerTool('estimate',
    { title: '费用预估', description: '提交前预估扣费(参数同 generate_*,加 type)。', inputSchema: { type: z.string(), prompt: z.string().optional(), text: z.string().optional(), count: z.number().int().optional(), model: z.string().optional(), resolution: z.string().optional(), duration: z.number().int().optional() } },
    async (a) => {
      const r = await estimateJob(actor.tenantId, a as Record<string, unknown>);
      return r.ok ? ok({ cost: r.cost, ...(r.extra ?? {}) }) : err(r.error);
    });

  return server;
}

export const mcpRouter = Router();

// stateless:每请求认证 → 限速 → 新建 server+transport → handleRequest。
mcpRouter.post('/', async (req: Request, res: Response) => {
  const viaKey = resolveApiKeyFull(req.headers.authorization);
  if (!viaKey) {
    res.status(401).json({ error: '密钥无效或未提供', code: 'UNAUTHORIZED' });
    return;
  }
  if (viaKey.user.role !== 'admin' && viaKey.user.role !== 'creator') {
    res.status(403).json({ error: 'viewer 密钥不能发起生成', code: 'ROLE_FORBIDDEN' });
    return;
  }
  // tools/call 走写限速,其余(initialize/tools/list)走读限速。best-effort 从 body 判定 method。
  const method = (req.body as { method?: string } | undefined)?.method ?? '';
  const limiter = method === 'tools/call' ? writeLimiter : readLimiter;
  if (!limiter.allow(viaKey.keyId)) {
    res.status(429).json({ error: '请求过于频繁,请稍后重试', code: 'RATE_LIMITED' });
    return;
  }

  const actor: SubmitActor = { tenantId: viaKey.user.tenantId, userId: viaKey.user.id, role: viaKey.user.role, ip: null, apiKeyId: viaKey.keyId };
  const server = buildMcpServer(actor);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }); // stateless
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
