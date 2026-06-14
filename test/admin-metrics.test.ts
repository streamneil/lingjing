// 灵镜 运营监控驾驶舱测试 —— /admin/api/metrics/*。
//
// 设计来源:/plan-ceo-review 监控规划轮。验证四点:
//   ① 聚合 SQL 正确(overview 的 queued/running/今日完成失败/失败率/耗时)
//   ② 瓶颈灯阈值边界(5/6 → green/amber,15/16 → amber/red)
//   ③ 租户维度隔离(by-tenant 不串租户)
//   ④ 超管鉴权(无 lj_padmin → 401),与现有 /admin 路由同款结构隔离

import { describe, it, expect, beforeAll } from 'vitest';

process.env.DB_FILE = ':memory:';
process.env.SUPERADMIN_USER = 'admin';
process.env.SUPERADMIN_PASS = 'superpw123';

const { createApp } = await import('../src/server.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { bootstrapSuperadmin } = await import('../src/auth/platform.js');
const { db } = await import('../src/db/index.js');
const { Client } = await import('./helpers.js');

const app = createApp();
let tenantA: string;
let tenantB: string;

/** 直接插一条 job(测试控制 status/时间戳)。input_json 给个最小占位。 */
let seq = 0;
function seedJob(opts: {
  tenant: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  createdAt: number;
  startedAt?: number | null;
  updatedAt?: number;
  type?: string;
  error?: string | null;
}) {
  const id = `job-test-${++seq}`;
  db.prepare(
    `INSERT INTO job (id, tenant_id, type, status, progress, input_json, error, attempts, created_at, updated_at, started_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    opts.tenant,
    opts.type ?? 'video',
    opts.status,
    opts.status === 'done' ? 100 : 0,
    '{}',
    opts.error ?? null,
    1,
    opts.createdAt,
    opts.updatedAt ?? opts.createdAt,
    opts.startedAt ?? null,
  );
  return id;
}

async function padminLogin(): Promise<InstanceType<typeof Client>> {
  const c = new Client(app);
  const r = await c.login('admin', 'superpw123', '/admin/login');
  expect(r.status).toBe(200);
  return c;
}

const NOW = Date.now();
const todayStart = (() => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
})();

beforeAll(async () => {
  await bootstrapSuperadmin();
  tenantA = createTenant('电视台A').id;
  tenantB = createTenant('报社B').id;
  await createUser(tenantA, 'a-admin', 'pw123456', 'admin');

  // 清掉可能的历史 job,从干净状态造数据。
  db.prepare(`DELETE FROM job`).run();

  // 租户 A:今日 2 完成(耗时 60s/180s)、1 失败、1 排队、1 进行中。
  seedJob({ tenant: tenantA, status: 'done', createdAt: todayStart + 1000, startedAt: todayStart + 2000, updatedAt: todayStart + 62000 }); // 60s
  seedJob({ tenant: tenantA, status: 'done', createdAt: todayStart + 3000, startedAt: todayStart + 4000, updatedAt: todayStart + 184000 }); // 180s
  seedJob({ tenant: tenantA, status: 'failed', createdAt: todayStart + 5000, startedAt: todayStart + 6000, updatedAt: todayStart + 9000, error: 'boom' });
  seedJob({ tenant: tenantA, status: 'queued', createdAt: NOW - 10000 });
  seedJob({ tenant: tenantA, status: 'running', createdAt: NOW - 20000, startedAt: NOW - 15000 });

  // 租户 B:今日 1 完成、1 进行中。
  seedJob({ tenant: tenantB, status: 'done', createdAt: todayStart + 7000, startedAt: todayStart + 8000, updatedAt: todayStart + 38000 }); // 30s
  seedJob({ tenant: tenantB, status: 'running', createdAt: NOW - 5000, startedAt: NOW - 3000 });
});

describe('鉴权隔离(无 lj_padmin → 401)', () => {
  it('未登录打 overview → 401', async () => {
    const c = new Client(app);
    const r = await c.get('/admin/api/metrics/overview');
    expect(r.status).toBe(401);
  });
  it('租户 session 打 by-tenant → 401(结构隔离)', async () => {
    const tenant = new Client(app);
    await tenant.login('a-admin', 'pw123456');
    const r = await tenant.get('/admin/api/metrics/by-tenant');
    expect(r.status).toBe(401);
  });
});

describe('overview 聚合', () => {
  it('queued/running/今日完成失败/失败率/平均耗时正确', async () => {
    const c = await padminLogin();
    const r = await c.get('/admin/api/metrics/overview');
    expect(r.status).toBe(200);
    const b = r.body;
    expect(b.queued).toBe(1); // A 的 1 个 queued
    expect(b.running).toBe(2); // A1 + B1
    expect(b.todayDone).toBe(3); // A2 + B1
    expect(b.todayFailed).toBe(1); // A1
    expect(b.failRate).toBeCloseTo(1 / 4, 5); // 1 失败 / 4 终态
    // 平均耗时 = (60s + 180s + 30s) / 3 = 90s
    expect(b.avgDurationMs).toBe(90000);
    expect(b.level).toBe('red'); // queued=1 虽低,但失败率 25% > 10% → red
  });
});

describe('瓶颈灯阈值边界', () => {
  // 用纯函数语义复测边界:通过造 queued 数验证 green/amber/red 切换。
  // 复用 overview 接口(失败率/排队时长此处控为 0:无失败、queued 都是刚入队)。
  async function levelForQueued(n: number): Promise<string> {
    db.prepare(`DELETE FROM job`).run();
    for (let i = 0; i < n; i++) seedJob({ tenant: tenantA, status: 'queued', createdAt: NOW - 1000 });
    const c = await padminLogin();
    const r = await c.get('/admin/api/metrics/overview');
    return r.body.level;
  }
  it('queued=5 → green(边界内)', async () => {
    expect(await levelForQueued(5)).toBe('green');
  });
  it('queued=6 → amber(越过 5)', async () => {
    expect(await levelForQueued(6)).toBe('amber');
  });
  it('queued=15 → amber(边界内)', async () => {
    expect(await levelForQueued(15)).toBe('amber');
  });
  it('queued=16 → red(越过 15)', async () => {
    expect(await levelForQueued(16)).toBe('red');
  });
  it('失败率 > 10% → red', async () => {
    db.prepare(`DELETE FROM job`).run();
    // 8 完成 + 2 失败 = 20% 失败率 > 10%
    for (let i = 0; i < 8; i++) seedJob({ tenant: tenantA, status: 'done', createdAt: todayStart + 1000, startedAt: todayStart + 2000, updatedAt: todayStart + 12000 });
    for (let i = 0; i < 2; i++) seedJob({ tenant: tenantA, status: 'failed', createdAt: todayStart + 1000 });
    const c = await padminLogin();
    const r = await c.get('/admin/api/metrics/overview');
    expect(r.body.failRate).toBeCloseTo(0.2, 5);
    expect(r.body.level).toBe('red');
  });
});

describe('by-tenant 租户隔离', () => {
  it('各租户计数独立、不串', async () => {
    db.prepare(`DELETE FROM job`).run();
    seedJob({ tenant: tenantA, status: 'queued', createdAt: NOW - 1000 });
    seedJob({ tenant: tenantA, status: 'done', createdAt: todayStart + 1000, startedAt: todayStart + 2000, updatedAt: todayStart + 12000 });
    seedJob({ tenant: tenantB, status: 'running', createdAt: NOW - 1000, startedAt: NOW - 500 });
    const c = await padminLogin();
    const r = await c.get('/admin/api/metrics/by-tenant');
    expect(r.status).toBe(200);
    const a = r.body.tenants.find((t: any) => t.tenantId === tenantA);
    const bt = r.body.tenants.find((t: any) => t.tenantId === tenantB);
    expect(a.name).toBe('电视台A');
    expect(a.queued).toBe(1);
    expect(a.todayCount).toBe(1); // 1 完成
    expect(a.running).toBe(0);
    expect(bt.name).toBe('报社B');
    expect(bt.running).toBe(1);
    expect(bt.queued).toBe(0);
  });
});

describe('recent-jobs', () => {
  it('按租户过滤,只返回该租户任务,不下发 input_json', async () => {
    db.prepare(`DELETE FROM job`).run();
    seedJob({ tenant: tenantA, status: 'done', createdAt: todayStart + 1000, startedAt: todayStart + 2000, updatedAt: todayStart + 12000 });
    seedJob({ tenant: tenantB, status: 'failed', createdAt: todayStart + 1000, error: 'x' });
    const c = await padminLogin();
    const r = await c.get(`/admin/api/metrics/recent-jobs?tenant=${tenantA}`);
    expect(r.status).toBe(200);
    expect(r.body.jobs.length).toBe(1);
    expect(r.body.jobs[0].tenant_id).toBe(tenantA);
    expect(r.body.jobs[0].input_json).toBeUndefined(); // 不下发入参
    expect(r.body.jobs[0].durationMs).toBe(10000); // 完成耗时
  });
});

describe('concurrency 趋势', () => {
  it('返回按小时分桶序列,长度=hours', async () => {
    const c = await padminLogin();
    const r = await c.get('/admin/api/metrics/concurrency?range=24h');
    expect(r.status).toBe(200);
    expect(r.body.hours).toBe(24);
    expect(Array.isArray(r.body.series)).toBe(true);
    expect(r.body.series.length).toBe(24);
  });
});
