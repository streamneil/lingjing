// /mcp 并发在飞字节闸(v0.9.2,eng-review D12 + 外部声音 P2)。
//
// 修的事:粗粒度限速器管的是**频率**(300 次/分钟/密钥),管不了**同时有多少字节在内存里**。
// v0.9.2 新增 upload_video / upload_audio 两条 20MB 上传路径后,单个已鉴权请求的常态足迹就是
// 几十 MB —— 速率闸完全放得下十几路并发大上传同时在飞,那是几百 MB 的瞬时占用。
// 2026-07-25 修的是**未鉴权**放大(把鉴权前移到 parser 之前),这条管的是**已鉴权**并发量,
// 两者互补,都必须在 body parser 之前。
//
// 本文件把 MCP_INFLIGHT_BYTES 设成一个很小的值,让单个请求就能触闸,从而无需真的并发。

import { describe, it, expect, beforeAll } from 'vitest';
import http from 'node:http';

process.env.DB_FILE = ':memory:';
process.env.DASHSCOPE_API_KEY = 'sk-test';
process.env.MCP_INFLIGHT_BYTES = '1mb'; // 必须在 import server 之前设(启动期读一次)

const { createApp } = await import('../src/server.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { createApiKey } = await import('../src/auth/api-keys.js');
const { serverPort } = await import('./helpers.js');

const app = createApp();
let port = 0;
let key = '';

/** 直接发裸 HTTP(不走 MCP SDK):要控制 Content-Length 与 body 大小。 */
function post(bodyBuf: Buffer, bearer?: string): Promise<{ status: number; body: Record<string, unknown>; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      // Streamable HTTP transport 要求同时接受 JSON 与 SSE,否则 406(与本文件要测的闸无关)
      Accept: 'application/json, text/event-stream',
      'Content-Length': String(bodyBuf.length),
    };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let json: Record<string, unknown>;
        try { json = JSON.parse(buf); } catch { json = { raw: buf }; }
        resolve({ status: res.statusCode!, body: json, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

/** 造一个 Content-Length 为 n 字节的合法 JSON。 */
function padded(bytes: number): Buffer {
  const shell = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}, _pad: '' });
  const pad = 'x'.repeat(Math.max(0, bytes - shell.length));
  return Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}, _pad: pad }));
}

beforeAll(async () => {
  const tId = createTenant('并发闸台').id;
  const uid = (await createUser(tId, 'inflight', 'pw123456', 'creator')).id;
  key = createApiKey(tId, uid, 'inflight-key').key;
  port = await serverPort(app);
}, 30000);

describe('/mcp 并发在飞字节闸', () => {
  it('单请求超过 MCP_INFLIGHT_BYTES → 429 + Retry-After(不是 413,也没进 parser)', async () => {
    const r = await post(padded(2 * 1024 * 1024), key); // 2MB > 闸值 1mb
    expect(r.status).toBe(429);
    expect(r.body.code).toBe('RATE_LIMITED');
    expect(r.headers['retry-after']).toBeTruthy(); // 可退避 —— Agent 据此知道「等等再来」而不是「改参数」
    expect(String(r.body.error)).toContain('繁忙');
  });

  // 下面两条只关心「有没有被闸拦下」,不关心 JSON-RPC 本身是否成功 —— 裸 tools/list 没先
  // initialize,协议层会回 400,那是 transport 的责任,不该由本文件断言。
  it('闸内的请求正常放行(不误伤日常调用)', async () => {
    const r = await post(padded(1024), key);
    // 断具体值而非 not.toBe(429):后者在 500/401/服务崩了时也过,当不了对照组。
    // 400 是协议层对「裸 tools/list 没先 initialize」的回应,见上方注释。
    expect(r.status).toBe(400);
  });

  it('请求结束后额度被释放 —— 连发多个请求不会累积到触闸', async () => {
    // 每个 50KB,20 个累计 1MB 已达全局闸值。只有「用完即还」才能全部通过。
    for (let i = 0; i < 20; i++) {
      const r = await post(padded(50 * 1024), key);
      expect(r.status, `第 ${i + 1} 个请求被误拒,说明 close/finish 没释放额度`).not.toBe(429);
    }
  });

  it('匿名请求先撞 401 —— 字节闸不该把未鉴权流量的错误码盖掉', async () => {
    // 顺序护栏:鉴权在字节闸之前。反过来的话,攻击者能用超大 Content-Length 探测出
    // 「服务端当前有多忙」,而且拿到的错误码会掩盖真正的问题(密钥没配)。
    const r = await post(padded(2 * 1024 * 1024));
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('UNAUTHORIZED');
  });
});

// ── chunked 绕过防回归(v0.9.2 CRITICAL)────────────────────────────────────
// security 与 performance 两个专家独立实测:闸子只读 Content-Length 时,
// Transfer-Encoding: chunked 的请求被算作 0 字节直接放行 —— 十路并发 26.7MB
// chunked 上传全部 200,同样字节带 Content-Length 则被 429。一行客户端配置就能绕开。
// 修法是「未声明长度按 body 上限记账」。这条测试钉的就是那一行:
// 把 `: BODY_LIMIT_BYTES` 改回 `: 0`,下面立刻红。
describe('/mcp 并发字节闸 — chunked(无 Content-Length)不得免费通行', () => {
  /** 不设 Content-Length 发请求 → Node 自动用 Transfer-Encoding: chunked。 */
  function postChunked(bodyBuf: Buffer): Promise<{ status: number; body: Record<string, unknown>; sentCL?: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, path: '/mcp', method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          // 故意不给 Content-Length
        },
      }, (r) => {
        let b = '';
        r.on('data', (c) => (b += c));
        r.on('end', () => {
          let json: Record<string, unknown>;
          try { json = JSON.parse(b); } catch { json = { raw: b }; }
            // 记录实际发出的请求头:要证明的前提是「没发 Content-Length」——
          // 那正是服务端分支的判据。Node 内部加的 Transfer-Encoding 读不到,也不该依赖它。
          resolve({ status: r.statusCode!, body: json, sentCL: req.getHeader('content-length') as string | undefined });
        });
      });
      req.on('error', reject);
      req.write(bodyBuf);
      req.end();
    });
  }

  it('前提校验:本测试确实没发 Content-Length(否则测不到要测的分支)', async () => {
    const r = await postChunked(padded(512));
    expect(r.sentCL, '测试自己发了 Content-Length,就走不到未声明长度那条分支').toBeUndefined();
  });

  it('哪怕只有 1KB,未声明长度也按 body 上限记账 → 撞闸 429', async () => {
    // 闸值 1mb,body 上限回落 32mb。按 0 记就会放行,按上限记就必然超。
    const r = await postChunked(padded(512));
    expect(r.status, 'chunked 请求被免费放行了 —— 字节闸可被一行客户端配置绕开').toBe(429);
    expect(r.body.code).toBe('RATE_LIMITED');
  });

  it('对照组:同样大小带 Content-Length → 不撞闸(证明差异确实来自那个头)', async () => {
    const r = await post(padded(512), key);
    expect(r.status, '对照组必须断具体值,否则两边一起坏也看不出来').toBe(400);
  });
});
