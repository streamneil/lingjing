// 灵镜 生成来源标记 — job.channel 端到端。
//
// 用户诉求:「用 API 密钥 / MCP 生成的作品,要能在生成记录里一眼认出」。
// 落点是 job 行上的 channel 列(不是只靠 audit_log.via_api_key —— 记录列表直接读 job)。
//
// 覆盖三条提交路径 + 一条读路径:
//   - MCP tools/call(官方 SDK Client 打 /mcp)      → channel='mcp'
//   - REST POST /api/jobs 带 Bearer lj_sk_          → channel='rest'
//   - REST POST /api/jobs 带 cookie session(网页)  → channel='web'
//   - GET /api/jobs 列表 / GET /api/jobs/:id 详情都带出 channel(前端徽章据此渲染)

import { describe, it, expect, beforeAll } from 'vitest';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

process.env.DB_FILE = ':memory:';
process.env.DASHSCOPE_API_KEY = 'sk-test';

const { createApp } = await import('../src/server.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { createApiKey } = await import('../src/auth/api-keys.js');
const { grant } = await import('../src/credits/index.js');
const { getJob, enqueueJob } = await import('../src/queue/index.js');
const { seedPlatformDefaults } = await import('./../src/seed/platform-defaults.js');
const { Client } = await import('./helpers.js');

seedPlatformDefaults();
const app = createApp();
const client = new Client(app); // cookie 客户端(网页路径)
const keyClient = new Client(app); // 纯 key 客户端(从不登录)

let tId = '';
let creatorId = '';
let key = '';
let mcpPort = 0;

beforeAll(async () => {
  tId = createTenant('来源标记台').id;
  creatorId = (await createUser(tId, 'chcreator', 'pw123456', 'creator')).id;
  grant(tId, 1_000_000);
  key = createApiKey(tId, creatorId, 'ch-key').key;
  await client.login('chcreator', 'pw123456');
  // MCP 走官方 SDK transport,需要真实端口(helpers 的常驻 server 不暴露端口)。
  mcpPort = await new Promise<number>((resolve) => {
    const s = app.listen(0, () => resolve((s.address() as { port: number }).port));
    s.unref();
  });
}, 30000);

describe('提交路径 → job.channel', () => {
  it('MCP tools/call → channel=mcp', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
    });
    const mcp = new McpClient({ name: 'channel-test', version: '1.0.0' });
    await mcp.connect(transport);
    const res = await mcp.callTool({ name: 'generate_image', arguments: { prompt: 'MCP 出图', count: 1 } });
    const jobId = (res.structuredContent as { job_id: string }).job_id;
    await mcp.close();

    expect(getJob(jobId)!.channel).toBe('mcp');
  });

  it('REST + Bearer key → channel=rest', async () => {
    const r = await keyClient.postKey('/api/jobs', key, { type: 'ai_image', prompt: 'REST 出图', count: 1 });
    expect(r.status).toBe(202);
    expect(getJob(r.body.id)!.channel).toBe('rest');
  });

  it('网页 cookie session → channel=web(不显徽章)', async () => {
    const r = await client.post('/api/jobs', { type: 'ai_image', prompt: '网页出图', count: 1 });
    expect(r.status).toBe(202);
    expect(getJob(r.body.id)!.channel).toBe('web');
  });

  it('老路径 enqueueJob 不传 channel → NULL(老 job 不因新列炸,前端按网页处理)', () => {
    const id = enqueueJob('ai_image', { prompt: '老作品' }, tId, creatorId);
    expect(getJob(id)!.channel).toBeNull();
  });
});

describe('读路径带出 channel(前端徽章数据源)', () => {
  it('GET /api/jobs 列表每条带 channel', async () => {
    const r = await client.get('/api/jobs?type=ai_image');
    expect(r.status).toBe(200);
    const byChannel = Object.fromEntries(r.body.jobs.map((j: { script: string; channel: string }) => [j.script, j.channel]));
    expect(byChannel['MCP 出图']).toBe('mcp');
    expect(byChannel['REST 出图']).toBe('rest');
    expect(byChannel['网页出图']).toBe('web');
  });

  it('GET /api/jobs/:id 详情带 channel(轮询期间徽章不闪没)', async () => {
    const sub = await keyClient.postKey('/api/jobs', key, { type: 'ai_image', prompt: '详情查来源', count: 1 });
    const r = await client.get('/api/jobs/' + sub.body.id);
    expect(r.status).toBe(200);
    expect(r.body.channel).toBe('rest');
  });
});
