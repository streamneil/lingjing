// 灵镜 Open API — 「永远装不下」的请求必须是永久失败,不是可重试失败(v0.9.2,真机冒烟发现)。
//
// 背景:/mcp 的请求管线里,并发字节闸(按 Content-Length 记账)排在 express.json 之前,
// 而人头预算的下界正好等于 body 上限。于是一个**超过 body 上限**的请求会先撞上字节闸,
// 拿到 429 + Retry-After —— 而 429 的语义是「现在忙,待会儿再来」。
//
// 这条语义是错的,且后果具体:文档告诉 Agent「文件太大就改走 REST multipart」,
// 而那条自救路**只有拿到 413 才会被触发**。收到 429 的 Agent 会照着 Retry-After
// 无限退避重试,每次都得到同一个 429 —— 它永远走不到那条本来给它准备好的路上。
//
// 独立文件:MCP_BODY_LIMIT / MCP_INFLIGHT_BYTES 都在模块加载时读取,须在 import 前置好 env。

import { describe, it, expect, beforeAll } from 'vitest';

process.env.DB_FILE = ':memory:';
process.env.DASHSCOPE_API_KEY = 'sk-test';
// 关键配置:让 PER_KEY_INFLIGHT_MAX == BODY_LIMIT_BYTES(取 max(body上限, 全局/4),
// 全局/4 = 256kb < 1200kb → 取 1200kb)。这样任何超过 body 上限的请求都同时越过两道闸,
// 谁先跑谁决定状态码 —— 正是本条要钉死的顺序。
process.env.MCP_BODY_LIMIT = '1200kb';
process.env.MCP_INFLIGHT_BYTES = '1mb';

const { createApp } = await import('../src/server.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { createApiKey } = await import('../src/auth/api-keys.js');
const { serverPort } = await import('./helpers.js');

const app = createApp();
let port = 0;
let key = '';

beforeAll(async () => {
  const t = createTenant('超限台');
  const u = await createUser(t.id, 'oversizecreator', 'pw123456', 'creator');
  key = createApiKey(t.id, u.id, 'oversize-key').key;
  port = await serverPort(app);
}, 30000);

function post(body: Buffer) {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body,
  });
}

const rpcOfSize = (pad: number) => Buffer.from(JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _pad: 'x'.repeat(pad) },
}));

describe('/mcp 超 body 上限 → 永久失败(413),不是可重试失败(429)', () => {
  it('前提校验:这个体积确实同时越过了字节闸(否则本组断言在测空气)', () => {
    // BODY_LIMIT=1200kb=1228800B,MCP_INFLIGHT_BYTES=1mb=1048576B。
    // 1_300_000 > 两者 → 移除 413 分流后,字节闸必然抢先回 429。
    expect(1_300_000).toBeGreaterThan(1228800); // > body 上限
    expect(1_300_000).toBeGreaterThan(1048576); // > 全局在飞预算 → 老代码走 429
  });

  it('超 body 上限 → 413 而非 429(否则 Agent 会照着 Retry-After 无限重试)', async () => {
    const r = await post(rpcOfSize(1_300_000));
    expect(r.status).toBe(413);
    // 反向钉死:429 是本条要防的那个回归,单独断言一次让失败信息说人话
    expect(r.status).not.toBe(429);
  });

  it('413 不带 Retry-After(带了就是在邀请客户端重试一件永远不会成功的事)', async () => {
    const r = await post(rpcOfSize(1_300_000));
    expect(r.headers.get('retry-after')).toBeNull();
  });

  it('413 的正文告诉 Agent 那条自救路(REST multipart)', async () => {
    const r = await post(rpcOfSize(1_300_000));
    const j = await r.json() as { code: string; error: string };
    expect(j.code).toBe('PAYLOAD_TOO_LARGE');
    expect(j.error).toContain('1200kb');            // 回显实际上限
    expect(j.error).toContain('/api/video-uploads'); // 指出 REST 回落端点
  });

  it('未超上限的请求不受影响(分流不能误伤合法流量)', async () => {
    const r = await post(rpcOfSize(1000));
    expect(r.status).not.toBe(413);
    expect(r.status).not.toBe(429);
  });
});
