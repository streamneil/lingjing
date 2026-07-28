// /mcp JSON-RPC batch — 批量请求不得绕过写限速(v0.9.2,对抗评审发现)。
//
// 两轮六专家都漏了这条:限速分档只看单条对象的 body.method,而 JSON-RPC 允许 body 是**数组**,
// 我们用的 transport 也确实会逐条派发(streamableHttp 内部包 WebStandardStreamableHTTPServerTransport,
// 它 Array.isArray 后循环)。数组上 body.method 是 undefined → 判成「一次读」放行 →
// 里面 N 条 generate_* 全跑真实提交:写限速形同虚设,余额可被一口气抽干,事件循环被钉住
// (worker 同进程)。而且 stateless 下不用先 initialize 就能打。
//
// 写限速设成 3:一个 4 条 tools/call 的数组必须被拦。

import { describe, it, expect, beforeAll } from 'vitest';
import http from 'node:http';

process.env.DB_FILE = ':memory:';
process.env.DASHSCOPE_API_KEY = 'sk-test';
process.env.API_RATE_WRITE_PER_MIN = '3';
process.env.API_RATE_READ_PER_MIN = '1000';

const { createApp } = await import('../src/server.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { createApiKey } = await import('../src/auth/api-keys.js');
const { grant } = await import('../src/credits/index.js');
const { seedPlatformDefaults } = await import('../src/seed/platform-defaults.js');
const { serverPort } = await import('./helpers.js');

seedPlatformDefaults();
const app = createApp();
let port = 0;
let key = '';

function post(payload: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const buf = Buffer.from(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/mcp', method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Content-Length': String(buf.length),
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
    req.write(buf);
    req.end();
  });
}

const call = (id: number, name: string) =>
  ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { prompt: 'x', count: 1 } } });

beforeAll(async () => {
  const tId = createTenant('batch 台').id;
  const uid = (await createUser(tId, 'batchuser', 'pw123456', 'creator')).id;
  grant(tId, 10_000_000);
  key = createApiKey(tId, uid, 'batch-key').key;
  port = await serverPort(app);
}, 30000);

describe('/mcp JSON-RPC batch 不得绕过写限速', () => {
  it('4 条生成调用的数组 → 429(写档只有 3;按条计数,不是按请求)', async () => {
    const r = await post([1, 2, 3, 4].map((i) => call(i, 'generate_image')));
    expect(r.status, '数组被当成「一次读」放行了 —— 写限速形同虚设').toBe(429);
    expect(r.body.code).toBe('RATE_LIMITED');
  });

  it('全是只读工具的数组走读档,不吃生成配额', async () => {
    const r = await post([1, 2, 3, 4, 5].map((i) => call(i, 'get_balance')));
    expect(r.status, '只读批量被算成写,会把轮询变成生成配额').not.toBe(429);
  });

  it('批量长度超上限 → 413,而不是扇出执行', async () => {
    const r = await post(Array.from({ length: 25 }, (_, i) => call(i, 'get_balance')));
    expect(r.status).toBe(413);
    expect(r.body.code).toBe('PAYLOAD_TOO_LARGE');
    expect(String(r.body.error)).toContain('20');
  });

  it('数组里混一条生成 → 整批按写档计(不能被只读条目稀释)', async () => {
    const r = await post([call(1, 'get_balance'), call(2, 'get_balance'), call(3, 'get_balance'), call(4, 'generate_image')]);
    // 前三条走读档(1000/min 够),第四条走写档 —— 写档此时已被上面第一个用例耗尽
    expect(r.status).toBe(429);
  });

  it('取不到工具名的畸形条目按写档算(保守方向,宁可严不可松)', async () => {
    const r = await post([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} }]);
    expect(r.status, '畸形条目被放行到读档了').toBe(429);
  });
});
