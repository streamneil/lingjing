// 灵镜 Open API — 限速 429 必须带 Retry-After(v0.9.2,真机冒烟发现)。
//
// 两道速率闸(解析前粗闸、解析后读写分级闸)此前都只回一句「请稍后重试」,不带 Retry-After。
// 对人无所谓,对 Agent 是真问题:它拿不到退避时长只能猜 —— 猜短了继续撞墙(撞墙不计数,
// 但白跑一轮 RTT,而且看起来像服务挂了),猜长了白等一整分钟。
// 滑动窗口自己精确知道下一个名额什么时候释放,没有理由不告诉调用方。
//
// 独立文件:限速阈值在模块加载时读取,须在 import 前置好 env;压到极小值才能在测试里跑满。

import { describe, it, expect, beforeAll } from 'vitest';

process.env.DB_FILE = ':memory:';
process.env.DASHSCOPE_API_KEY = 'sk-test';
process.env.API_RATE_WRITE_PER_MIN = '2';
process.env.API_RATE_READ_PER_MIN = '3';

const { createApp } = await import('../src/server.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { createApiKey } = await import('../src/auth/api-keys.js');
const { serverPort } = await import('./helpers.js');
const { SlidingWindowLimiter } = await import('../src/auth/rate-limit.js');

const app = createApp();
let port = 0;
let key = '';

beforeAll(async () => {
  const t = createTenant('退避台');
  const u = await createUser(t.id, 'retrycreator', 'pw123456', 'creator');
  key = createApiKey(t.id, u.id, 'retry-key').key;
  port = await serverPort(app);
}, 30000);

function post(body: unknown) {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  });
}
const callMsg = (id: number, name: string, args: Record<string, unknown> = {}) =>
  ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

describe('限速 429 带 Retry-After', () => {
  it('写限速打满 → 429 带 Retry-After,且是可用的正整数秒', async () => {
    let hit: Response | null = null;
    // 写档 2/min:第 3 次必然被拒。多打几次防止前面有别的写操作占了名额。
    for (let i = 0; i < 6 && !hit; i++) {
      const r = await post(callMsg(i + 1, 'generate_image', { prompt: 'x', dry_run: true }));
      if (r.status === 429) hit = r; else await r.arrayBuffer();
    }
    expect(hit, '写限速压到 2/min 后仍未触发 429 —— 限速闸没生效,本条在测空气').not.toBeNull();
    const ra = hit!.headers.get('retry-after');
    expect(ra).not.toBeNull();
    const secs = Number(ra);
    expect(Number.isInteger(secs)).toBe(true);
    // 上界是窗口长度(60s),下界必须 >0:Retry-After: 0 等于没退避
    expect(secs).toBeGreaterThan(0);
    expect(secs).toBeLessThanOrEqual(60);
    const j = await hit!.json() as { code: string; error: string };
    expect(j.code).toBe('RATE_LIMITED');
    expect(j.error).toContain('写');   // 告诉 Agent 撞的是哪一档
    expect(j.error).toContain('2');    // 回显实际阈值,而不是笼统「过于频繁」
  });
});

// 直接测限速器本身:HTTP 层只能观察到「是个合理的秒数」,算得准不准要在这里钉。
describe('SlidingWindowLimiter.retryAfterSeconds', () => {
  it('刚打满时 ≈ 整个窗口长度', () => {
    const l = new SlidingWindowLimiter(60_000, 2);
    expect(l.allow('k')).toBe(true);
    expect(l.allow('k')).toBe(true);
    expect(l.allow('k')).toBe(false);
    const s = l.retryAfterSeconds('k');
    expect(s).toBeGreaterThanOrEqual(59);
    expect(s).toBeLessThanOrEqual(60);
  });

  it('随时间推移递减(不是写死的常数 —— 写死就等于没算)', async () => {
    const l = new SlidingWindowLimiter(3_000, 1);
    l.allow('k');
    const first = l.retryAfterSeconds('k');
    await new Promise((r) => setTimeout(r, 1_100));
    const later = l.retryAfterSeconds('k');
    expect(first).toBe(3);
    expect(later).toBeLessThan(first);
  });

  it('从未命中过的 key 回 1 而不是 0(0 秒退避等于不退避)', () => {
    const l = new SlidingWindowLimiter(60_000, 1);
    expect(l.retryAfterSeconds('never-seen')).toBe(1);
  });
});
