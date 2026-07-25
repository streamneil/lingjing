// 灵镜 Open API — MCP server 端到端(PR2,设计文档 §5 + D6)。
//
// 用官方 SDK Client 走完整协议(initialize → tools/list → tools/call)打真实 /mcp 端点,
// 同一把 lj_sk_ 密钥认证。覆盖协议层 + 工具逻辑层(D6 两层都测)。

import { describe, it, expect, beforeAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

process.env.DB_FILE = ':memory:';
process.env.DASHSCOPE_API_KEY = 'sk-test';

const { createApp } = await import('../src/server.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { createApiKey } = await import('../src/auth/api-keys.js');
const { grant } = await import('../src/credits/index.js');
const { getJob } = await import('../src/queue/index.js');
const { seedPlatformDefaults } = await import('../src/seed/platform-defaults.js');
const { serverPort } = await import('./helpers.js');

seedPlatformDefaults(); // 种默认模型(list_models 才有内容,与生产一致)
const app = createApp();
// MCP SDK transport 要真实 URL → 用 helpers 的常驻 server 端口(不自己 listen,见 helpers 文件头)。
let port = 0;
let key = '';
let tId = '';
let creatorId = '';

beforeAll(async () => {
  tId = createTenant('MCP 台').id;
  creatorId = (await createUser(tId, 'mcpcreator', 'pw123456', 'creator')).id;
  grant(tId, 1_000_000);
  key = createApiKey(tId, creatorId, 'mcp-key').key;
  port = await serverPort(app);
}, 30000);

function mcpClient(bearer: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
  });
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  return { client, transport };
}

describe('MCP 协议层(官方 SDK Client)', () => {
  it('initialize + tools/list 暴露生成工具', async () => {
    const { client, transport } = mcpClient(key);
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('generate_image');
    expect(names).toContain('generate_video');
    expect(names).toContain('generate_music');
    expect(names).toContain('generate_speech');
    expect(names).toContain('get_job');
    expect(names).toContain('list_models');
    expect(names).toContain('list_voices');
    expect(names).toContain('list_avatars');
    expect(names).toContain('estimate');
    await client.close();
  });

  it('generate_image → 返回 job_id + cost(structuredContent),异步口径', async () => {
    const { client, transport } = mcpClient(key);
    await client.connect(transport);
    const res = await client.callTool({ name: 'generate_image', arguments: { prompt: '一只柴犬', count: 1 } });
    const sc = res.structuredContent as { job_id: string; cost: number; status: string };
    expect(sc.job_id).toBeTruthy();
    expect(sc.status).toBe('queued');
    expect(sc.cost).toBeGreaterThan(0);
    expect(getJob(sc.job_id)!.tenant_id).toBe(tId); // 真入队,归属本租户
    await client.close();
  });

  it('get_job → 返回任务状态', async () => {
    const { client, transport } = mcpClient(key);
    await client.connect(transport);
    const gen = await client.callTool({ name: 'generate_image', arguments: { prompt: '查询用', count: 1 } });
    const jobId = (gen.structuredContent as { job_id: string }).job_id;
    const res = await client.callTool({ name: 'get_job', arguments: { job_id: jobId } });
    const sc = res.structuredContent as { status: string };
    expect(['queued', 'running', 'done', 'failed']).toContain(sc.status);
    await client.close();
  });

  it('list_models → 返回图片模型清单', async () => {
    const { client, transport } = mcpClient(key);
    await client.connect(transport);
    const res = await client.callTool({ name: 'list_models', arguments: { kind: 'image' } });
    const sc = res.structuredContent as { models: unknown[] };
    expect(Array.isArray(sc.models)).toBe(true);
    expect(sc.models.length).toBeGreaterThan(0);
    await client.close();
  });

  it('estimate → 返回预估费用', async () => {
    const { client, transport } = mcpClient(key);
    await client.connect(transport);
    const res = await client.callTool({ name: 'estimate', arguments: { type: 'ai_image', prompt: 'x', count: 1 } });
    const sc = res.structuredContent as { cost: number };
    expect(typeof sc.cost).toBe('number');
    await client.close();
  });
});

describe('MCP 认证', () => {
  it('伪造 key → 连接被拒(HTTP 401)', async () => {
    const { client, transport } = mcpClient('lj_sk_deadbeefdeadbeefdeadbeefdeadbeef');
    await expect(client.connect(transport)).rejects.toThrow();
  });

  it('无 Authorization 头 → 401', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    const client = new Client({ name: 'noauth', version: '1.0.0' });
    await expect(client.connect(transport)).rejects.toThrow();
  });
});
