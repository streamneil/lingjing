// /mcp 并发字节闸 — 单密钥子预算(v0.9.2 round-2)。
//
// 背景:「未声明 Content-Length 按 body 上限记账」这条保守修法自带副作用 —— 一个 chunked
// 请求不管实际多小都占满一个 body 上限的额度。计数器又是进程全局、不分租户,Node 默认
// requestTimeout 还有 300 秒,于是任一客户开几条慢连接就能把**全平台**的 /mcp 堵死。
// 人头闸把爆炸半径从「全平台」缩到「该密钥自己」。
//
// 本文件单独一个配置:全局预算必须明显大于 body 上限,人头闸才谈得上生效
// (mcp-inflight-bytes.test.ts 用的是「全局 < body 上限」那种极端配置,那里由全局闸兜底)。
// 人头上限 = max(body 上限, 全局/4) = max(1mb, 2mb) = 2mb。

import { describe, it, expect, beforeAll } from 'vitest';
import http from 'node:http';

process.env.DB_FILE = ':memory:';
process.env.DASHSCOPE_API_KEY = 'sk-test';
process.env.MCP_INFLIGHT_BYTES = '8mb';
process.env.MCP_BODY_LIMIT = '1mb';

const { createApp } = await import('../src/server.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { createApiKey } = await import('../src/auth/api-keys.js');
const { serverPort } = await import('./helpers.js');

const app = createApp();
let port = 0;
let keyA = '';
let keyB = '';

function post(bodyBuf: Buffer, bearer: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/mcp', method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Content-Length': String(bodyBuf.length),
      },
    }, (r) => {
      let b = '';
      r.on('data', (c) => (b += c));
      r.on('end', () => {
        let json: Record<string, unknown>;
        try { json = JSON.parse(b); } catch { json = { raw: b }; }
        resolve({ status: r.statusCode!, body: json });
      });
    });
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

const padded = (bytes: number): Buffer => Buffer.from(JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}, _pad: 'x'.repeat(Math.max(0, bytes - 120)),
}));

beforeAll(async () => {
  const tA = createTenant('甲机构').id;
  const uA = (await createUser(tA, 'perkey-a', 'pw123456', 'creator')).id;
  keyA = createApiKey(tA, uA, 'key-a').key;
  const tB = createTenant('乙机构').id;
  const uB = (await createUser(tB, 'perkey-b', 'pw123456', 'creator')).id;
  keyB = createApiKey(tB, uB, 'key-b').key;
  port = await serverPort(app);
}, 30000);

describe('/mcp 单密钥子预算', () => {
  it('单密钥超过人头上限(2mb)→ 429,即便全局预算(8mb)还很宽裕', async () => {
    const r = await post(padded(3 * 1024 * 1024), keyA);
    expect(r.status, '人头闸没生效:单密钥能一路吃到全局预算').toBe(429);
    expect(r.body.code).toBe('RATE_LIMITED');
  });

  it('另一把密钥不受影响 —— 隔离的是密钥,不是整条通道', async () => {
    const r = await post(padded(1024), keyB);
    expect(r.status, '别家密钥被连累了,说明只有全局闸在起作用').not.toBe(429);
  });

  it('人头额度按请求释放:同一把密钥连发不累积', async () => {
    for (let i = 0; i < 15; i++) {
      const r = await post(padded(512 * 1024), keyA); // 每个 512KB,低于 2mb 人头上限
      expect(r.status, `第 ${i + 1} 个请求被误拒 —— per-key 额度没释放`).not.toBe(429);
    }
  });

  it('人头上限不得低于 body 上限:一个满尺寸的合法请求必须发得出去', async () => {
    // 这条是真踩过的坑:人头上限一度取 全局/8 = 1mb,而 body 上限 32mb ——
    // 一个完全合法的大上传永远发不出去,闸子在拦自己允许的东西。
    const r = await post(padded(900 * 1024), keyA); // 接近 1mb body 上限
    expect(r.status, '满尺寸合法请求被人头闸拦了 —— 下界没取 body 上限').not.toBe(429);
  });
});
