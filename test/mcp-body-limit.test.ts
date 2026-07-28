// 灵镜 Open API — /mcp body 上限与超限提示(v0.8.0.7)。
//
// upload_image 走 base64 内联,故 /mcp 需要比全局 express.json({limit:'1mb'}) 大得多的上限,
// 且必须挂在全局 parser **之前**(见 server.ts)。两件事各锁一条:
//   1) 超过 1mb 的请求体不再被全局上限打死 —— 否则参考图一律传不进来
//   2) 超过 /mcp 自身上限时返回 **JSON** + 可执行建议,不是 express 默认的 HTML 错误页
//      (Agent 拿到一坨 HTML 只能瞎猜,这正是本次事故的错误类型)
//
// 独立文件:MCP_BODY_LIMIT 在模块加载时读取,需在 import 前置好 env。

import { describe, it, expect, beforeAll } from 'vitest';
import http from 'node:http';

process.env.DB_FILE = ':memory:';
process.env.DASHSCOPE_API_KEY = 'sk-test';
// 压到很小的值(生产默认 32mb)。刻意压到刚好跨过全局 1mb 的最小值:本套件 16 路 fork 并行跑,
// 每个 MB 级 payload 都是真实内存+IO 压力,会喂大仓库里那个已知的资源竞争 flake
// (见 TODOS T-TEST-ORDER-DEPENDENCE)。上限取 1200kb —— 必须 >1mb,否则第一条测试触不到全局 1mb 阈值、断言力归零。
process.env.MCP_BODY_LIMIT = '1200kb';

const { createApp } = await import('../src/server.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { createApiKey } = await import('../src/auth/api-keys.js');
const { serverPort } = await import('./helpers.js');

const app = createApp();
let port = 0;
let key = '';

beforeAll(async () => {
  const t = createTenant('MCP 体积台');
  const u = await createUser(t.id, 'bodycreator', 'pw123456', 'creator');
  key = createApiKey(t.id, u.id, 'body-key').key;
  port = await serverPort(app);
}, 30000);

/** 裸 POST /mcp(不走 SDK:要打的就是 body parser 这一层,SDK 会先握手)。
 *  bearer 传 null 则不带 Authorization 头(测匿名路径)。 */
function postMcp(
  body: Buffer,
  bearer: string | null = key,
): Promise<{ status: number; contentType: string; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1', port, path: '/mcp', method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(body.length),
          Accept: 'application/json, text/event-stream',
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({
          status: res.statusCode!,
          contentType: String(res.headers['content-type'] ?? ''),
          text: buf,
        }));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** 构造一条体积可控的合法 JSON-RPC 请求(padding 撑大 body)。 */
function rpcOfSize(padBytes: number): Buffer {
  return Buffer.from(JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/list',
    params: { _pad: 'x'.repeat(padBytes) },
  }));
}

describe('/mcp body 上限', () => {
  it('超过全局 1mb 的请求体不再被打死(base64 参考图能进来)', async () => {
    const r = await postMcp(rpcOfSize(1_100_000));
    expect(r.status).not.toBe(413); // 关键:全局 parser 若先跑,这里就是 413
  });

  it('超过 /mcp 上限 → 413 且是 JSON + 可执行建议(不是 HTML 错误页)', async () => {
    const r = await postMcp(rpcOfSize(1_300_000)); // > 1200kb
    expect(r.status).toBe(413);
    expect(r.contentType).toContain('application/json');
    const body = JSON.parse(r.text) as { error: string; code: string };
    expect(body.code).toBe('PAYLOAD_TOO_LARGE');
    expect(body.error).toContain('1200kb'); // 回显实际上限
    expect(body.error).toContain('压缩'); // 告诉 Agent 怎么自救
  });
});

// 落地前对抗审查发现:body 上限从 1mb 提到 32mb 后,若鉴权仍在 parser 之后,匿名请求就能让
// 进程先缓冲 32MB 再被 401 拒掉 —— 免鉴权的内存放大,且 parser 之后的限速器够不着。
// 鉴权已前移到 parser 之前;下面两条锁死「未认证流量不得触达 body parser」。
describe('/mcp 鉴权必须早于 body parser(免鉴权内存放大防回归)', () => {
  it('匿名 + 超限 body → 401 而非 413(证明根本没走到 parser)', async () => {
    const r = await postMcp(rpcOfSize(1_300_000), null);
    expect(r.status).toBe(401);
    expect(JSON.parse(r.text).code).toBe('UNAUTHORIZED');
  });

  it('伪造密钥 + 超限 body → 401 而非 413', async () => {
    const r = await postMcp(rpcOfSize(1_300_000), 'lj_sk_deadbeefdeadbeefdeadbeefdeadbeef');
    expect(r.status).toBe(401);
    expect(JSON.parse(r.text).code).toBe('UNAUTHORIZED');
  });

  it('合法密钥 + 超限 body → 413(鉴权通过后才轮到上限闸)', async () => {
    const r = await postMcp(rpcOfSize(1_300_000));
    expect(r.status).toBe(413);
  });
});

// ── 解析失败也必须回 JSON(v0.9.2)──────────────────────────────────────────
// 与 413 同源的病:app 没有全局错误中间件,body-parser 抛的解析错漏到 express 默认处理器
// 就是一张 HTML 错误页。Agent 拿到 HTML 只能瞎猜 —— 413 当初专门修过这个,解析失败漏了。
describe('/mcp 请求体解析失败', () => {
  it('畸形 JSON → 400 JSON + INVALID_PARAMS(不是 HTML 错误页)', async () => {
    const body = Buffer.from('{"jsonrpc":"2.0", BROKEN');
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body,
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json'); // 关键:不是 text/html
    const j = await res.json() as { code: string; error: string };
    expect(j.code).toBe('INVALID_PARAMS');
    expect(j.error).toContain('JSON');
  });
});
