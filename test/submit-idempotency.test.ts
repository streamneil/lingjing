// 灵镜 Open API — submitJob() 抽取 + Idempotency-Key(PR1 T3)。
//
// 覆盖(设计文档 §4.4 + eng-review D3/D4 + 外部声音 #6):
//   - submitJob 服务函数:builder→余额→入队→reserve→审计,返回 {ok,id,cost,reused}
//   - 幂等键:同键同 body → 返原 job(reused,不二次扣费);同键异 body → 409 CONFLICT
//   - 并发同键:撞唯一索引 → 返原 job(不 500)
//   - per-tenant:同键不同租户 → 各自独立 job
//   - HTTP:POST /jobs 带 Idempotency-Key 二次提交 → 202 然后 200,同一 id,只扣一次

import { describe, it, expect, beforeAll } from 'vitest';

process.env.DB_FILE = ':memory:';
process.env.DASHSCOPE_API_KEY = 'sk-test';

const { createApp } = await import('../src/server.js');
const { submitJob } = await import('../src/api/jobs.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { grant, balance } = await import('../src/credits/index.js');
const { getJob } = await import('../src/queue/index.js');
const { Client } = await import('./helpers.js');

const app = createApp();

let tA = '';
let tB = '';
let userA = '';
let userB = '';

beforeAll(async () => {
  tA = createTenant('幂等台 A').id;
  tB = createTenant('幂等台 B').id;
  userA = (await createUser(tA, 'idemA', 'pw123456', 'creator')).id;
  userB = (await createUser(tB, 'idemB', 'pw123456', 'creator')).id;
  grant(tA, 1000000);
  grant(tB, 1000000);
});

const actorA = () => ({ tenantId: tA, userId: userA, role: 'creator' as const, ip: null });

describe('submitJob 服务函数', () => {
  it('基本提交 → {ok,id,cost,status:queued,reused:false}', async () => {
    const r = await submitJob(actorA(), { type: 'ai_image', prompt: '一只猫', count: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.id).toBeTruthy();
    expect(r.status).toBe('queued');
    expect(r.cost).toBeGreaterThan(0);
    expect(r.reused).toBe(false);
    expect(getJob(r.id)!.tenant_id).toBe(tA);
  });

  it('未知 type → 400', async () => {
    const r = await submitJob(actorA(), { type: 'nope' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(400);
  });

  it('builder 校验失败透传(缺 prompt)→ 400', async () => {
    const r = await submitJob(actorA(), { type: 'ai_image', count: 1 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(400);
  });
});

describe('Idempotency-Key', () => {
  it('同键同 body → 返原 job(reused),不二次扣费', async () => {
    const before = balance(tA);
    const body = { type: 'ai_image', prompt: '幂等猫', count: 1 };
    const r1 = await submitJob(actorA(), body, 'idem-key-1');
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const afterFirst = balance(tA);
    expect(afterFirst).toBe(before - r1.cost); // 扣一次

    const r2 = await submitJob(actorA(), body, 'idem-key-1');
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.id).toBe(r1.id); // 同一 job
    expect(r2.reused).toBe(true);
    expect(r2.cost).toBe(r1.cost);
    expect(balance(tA)).toBe(afterFirst); // 未再扣
  });

  it('同键异 body → 409 IDEMPOTENCY_CONFLICT', async () => {
    await submitJob(actorA(), { type: 'ai_image', prompt: 'A', count: 1 }, 'idem-key-2');
    const r = await submitJob(actorA(), { type: 'ai_image', prompt: 'B 不同', count: 1 }, 'idem-key-2');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(409);
    expect(r.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('body 键顺序不同但内容相同 → 视为同键同 body(canonical hash)', async () => {
    const r1 = await submitJob(actorA(), { type: 'ai_image', prompt: 'canon', count: 1 }, 'idem-canon');
    const r2 = await submitJob(actorA(), { count: 1, prompt: 'canon', type: 'ai_image' }, 'idem-canon');
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r2.reused).toBe(true);
    expect(r2.id).toBe(r1.id);
  });

  it('并发同键 → 单 job、单扣费、一 reused(撞唯一索引不 500)', async () => {
    const before = balance(tA);
    const body = { type: 'ai_image', prompt: '并发', count: 1 };
    const [a, b] = await Promise.all([
      submitJob(actorA(), body, 'idem-concurrent'),
      submitJob(actorA(), body, 'idem-concurrent'),
    ]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.id).toBe(b.id); // 同一 job
    expect(a.reused !== b.reused).toBe(true); // 恰一个 reused
    const rows = getJob(a.id);
    expect(rows).toBeTruthy();
    // 只扣一次(不因两请求扣两次)
    expect(balance(tA)).toBe(before - a.cost);
  });

  it('同键不同租户 → 各自独立 job(per-tenant 作用域)', async () => {
    const body = { type: 'ai_image', prompt: '跨租户', count: 1 };
    const ra = await submitJob({ tenantId: tA, userId: userA, role: 'creator', ip: null }, body, 'idem-shared');
    const rb = await submitJob({ tenantId: tB, userId: userB, role: 'creator', ip: null }, body, 'idem-shared');
    expect(ra.ok && rb.ok).toBe(true);
    if (!ra.ok || !rb.ok) return;
    expect(ra.id).not.toBe(rb.id);
    expect(rb.reused).toBe(false);
  });

  it('无幂等键 → 每次都是新 job', async () => {
    const body = { type: 'ai_image', prompt: '无键', count: 1 };
    const r1 = await submitJob(actorA(), body);
    const r2 = await submitJob(actorA(), body);
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.id).not.toBe(r2.id);
  });
});

describe('HTTP POST /jobs 幂等(Idempotency-Key 头)', () => {
  const client = new Client(app);
  beforeAll(async () => {
    const r = await client.login('idemA', 'pw123456');
    expect(r.status).toBe(200);
  }, 30000);

  it('带 Idempotency-Key 二次提交 → 202 然后 200,同一 id', async () => {
    const body = { type: 'ai_image', prompt: 'http 幂等', count: 1 };
    const r1 = await client.post('/api/jobs', body, { 'Idempotency-Key': 'http-idem-1' });
    expect(r1.status).toBe(202);
    const r2 = await client.post('/api/jobs', body, { 'Idempotency-Key': 'http-idem-1' });
    expect(r2.status).toBe(200);
    expect(r2.body.id).toBe(r1.body.id);
  });

  it('不带头 → 行为不变(202,不同 id)', async () => {
    const body = { type: 'ai_image', prompt: '无头', count: 1 };
    const r1 = await client.post('/api/jobs', body);
    const r2 = await client.post('/api/jobs', body);
    expect(r1.status).toBe(202);
    expect(r2.status).toBe(202);
    expect(r1.body.id).not.toBe(r2.body.id);
  });
});
