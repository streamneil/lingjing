// /mcp 配置回落 — 「env 填错就静默关闸」防回归(v0.9.2)。
//
// 这类事故仓库里已经记过一次:body-parser 的 bytes.parse() 对解析不出的字符串返回 **null**,
// 而 null 在 express.json 里意味着**不设上限** —— 一个 .env 里的错别字就能把整个上限闸悄悄关掉,
// 且不报错。同一个陷阱在 v0.9.2 新增的 MCP_INFLIGHT_BYTES 上又出现一次(自己写的正则解析)。
//
// 所以两个 env 都必须:① 校验格式 ② 非法值告警并回落到安全默认 ③ **绝不**因为配错而放宽限制。
// 本文件把这三条钉死。env 在 import 前设置(两个值都是启动期读一次)。

import { describe, it, expect, beforeAll, vi } from 'vitest';

process.env.DB_FILE = ':memory:';
process.env.DASHSCOPE_API_KEY = 'sk-test';
// 两个都填成非法值 —— 期望:告警 + 回落默认,而不是「解析不出就不限制」。
process.env.MCP_INFLIGHT_BYTES = '一百二十八兆';
process.env.MCP_BODY_LIMIT = 'plenty';

const warnings: string[] = [];
const origWarn = console.warn;
console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); origWarn(...(a as [])); };

const { createApp } = await import('../src/server.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { createApiKey } = await import('../src/auth/api-keys.js');
const { grant } = await import('../src/credits/index.js');
const { serverPort } = await import('./helpers.js');

const app = createApp();
let port = 0;
let key = '';

beforeAll(async () => {
  const tId = createTenant('配置回落台').id;
  const uid = (await createUser(tId, 'cfguser', 'pw123456', 'creator')).id;
  grant(tId, 1_000_000);
  key = createApiKey(tId, uid, 'cfg-key').key;
  port = await serverPort(app);
}, 30000);

const post = (body: Buffer) => fetch(`http://127.0.0.1:${port}/mcp`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  },
  body,
});

/** 造一个约 n 字节的合法 JSON-RPC 请求体。 */
const padded = (bytes: number): Buffer => Buffer.from(JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}, _pad: 'x'.repeat(Math.max(0, bytes - 120)),
}));

describe('非法 env 必须告警,不能静默生效', () => {
  it('MCP_INFLIGHT_BYTES 与 MCP_BODY_LIMIT 各告警一次,且点明回落值', () => {
    const joined = warnings.join('\n');
    expect(joined, 'MCP_INFLIGHT_BYTES 非法却没告警 —— 运维不会知道闸值不是自己配的那个').toContain('MCP_INFLIGHT_BYTES');
    expect(joined).toContain('128mb');
    expect(joined, 'MCP_BODY_LIMIT 非法却没告警').toContain('MCP_BODY_LIMIT');
    expect(joined).toContain('32mb');
  });
});

describe('非法 env 回落到安全默认 —— 而不是「解析不出就不限制」', () => {
  it('body 上限回落 32mb:超过它仍返回 413,没有变成无上限', async () => {
    // 40MB > 回落值 32mb。若回落逻辑失效(limit=null),这里会一路进 parser 并成功,而不是 413。
    const res = await post(padded(40 * 1024 * 1024));
    expect([413, 429], `期望 413(超 body 上限)或 429(先撞并发字节闸),实得 ${res.status}`).toContain(res.status);
    const j = await res.json() as { code: string; error: string };
    expect(['PAYLOAD_TOO_LARGE', 'RATE_LIMITED']).toContain(j.code);
    expect(res.headers.get('content-type')).toContain('application/json'); // 永远不给 Agent 发 HTML
  });

  it('并发字节闸回落 128mb:多密钥并发把全局预算吃满后 429', async () => {
    // 只声明 Content-Length,不真发字节 —— 字节闸读的就是这个头,在读 body 之前判。
    // 用裸 http 而非 fetch:fetch 会因声明长度与实际写入不符而在客户端侧先炸,
    // 拿不到服务端的响应码,那就证明不了「是闸挡的」。
    //
    // 必须**多密钥并发**,不能一条大请求了事:回落后 body 上限 32mb、人头上限也是 32mb,
    // 任何单条超 32mb 的请求都会先被 413 分流(那是永久失败,见 mcp-oversize-permanent),
    // 单条 ≤32mb 又撑不爆 128mb 全局预算。所以全局闸本质上只有并发才观察得到。
    // 若 MCP_INFLIGHT_BYTES 回落成了 NaN,`x > NaN` 恒 false = 闸全开,下面一条 429 都不会有。
    const http = await import('node:http');
    const keys: string[] = [];
    for (let i = 0; i < 6; i++) {
      const t = createTenant(`回落台${i}`).id;
      const u = (await createUser(t, `cfgconc${i}`, 'pw123456', 'creator')).id;
      keys.push(createApiKey(t, u, `cfg-conc-${i}`).key);
    }
    const statuses: number[] = [];
    const retryAfters: (string | undefined)[] = [];
    const codes: string[] = [];
    const reqs = keys.map((k) => {
      const req = http.request({
        host: '127.0.0.1', port, path: '/mcp', method: 'POST',
        headers: {
          Authorization: `Bearer ${k}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          // 每条 30MB:< 32mb 人头/body 上限(不会被 413 分流),6 条 = 180MB > 128mb 全局预算。
          'Content-Length': String(30 * 1024 * 1024),
        },
      }, (r) => {
        let b = '';
        r.on('data', (c) => (b += c));
        r.on('end', () => {
          statuses.push(r.statusCode!);
          retryAfters.push(r.headers['retry-after'] as string | undefined);
          try { codes.push(String((JSON.parse(b) as { code?: string }).code)); } catch { /* 无正文 */ }
        });
      });
      req.on('error', () => { /* destroy 时的正常噪音 */ });
      req.write('{'); // 只写一个字节:请求挂在飞行中,额度被占住
      return req;
    });
    try {
      await new Promise((r) => setTimeout(r, 500));
      expect(statuses.filter((s) => s === 429).length,
        '非法 env 下字节闸失效了 —— 回落值没生效或变成了 NaN(NaN 比较恒 false = 闸全开)')
        .toBeGreaterThan(0);
      expect(statuses.includes(413), '30MB 在回落后的 32mb 上限内,不该被判永久超限').toBe(false);
      expect(retryAfters.some(Boolean)).toBe(true);
      expect(codes).toContain('RATE_LIMITED');
    } finally {
      reqs.forEach((r) => r.destroy());
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  it('正常大小的请求不受影响(回落不等于把闸调死)', async () => {
    const res = await post(padded(2048));
    expect(res.status).not.toBe(413);
    expect(res.status).not.toBe(429);
  });
});

describe('工具描述里的上限数字随配置走,不写死', () => {
  it('body 上限回落 32mb → upload_video 描述里的 MB 数是算出来的 20MB(min(20, 32×0.75))', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const c = new Client({ name: 'cfg', version: '1.0.0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
    }));
    const { tools } = await c.listTools();
    const uv = tools.find((t) => t.name === 'upload_video')!;
    // 32mb × 0.75 = 24MB,与工具自身的 20MB 上限取小 → 20MB
    expect(uv.description).toContain('20MB');
    // instructions 用的是同一个算出来的值,两处不能各写各的
    expect(c.getInstructions()).toContain('20MB');
    await c.close();
  });
});
