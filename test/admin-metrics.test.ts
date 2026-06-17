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

// ── 运营数据 /api/metrics/ops(2026-06-17 看板扩展)──
// 验口径铁律(spec/eng-review 抓的两个炸弹):消耗=reserve+release(非settle)、充值=credited(非grant)。
describe('运营数据 ops 端点', () => {
  let opsTenant: string;
  let opsTenant2: string;
  const today2 = (() => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime(); })();
  const month0 = (() => { const d = new Date(); d.setHours(0,0,0,0); d.setDate(1); return d.getTime(); })();
  let lseq = 0;
  function ledger(tenant: string, kind: string, amount: number, createdAt: number) {
    db.prepare(`INSERT INTO credit_ledger (id,tenant_id,kind,amount,created_at) VALUES (?,?,?,?,?)`)
      .run(`led-${++lseq}`, tenant, kind, amount, createdAt);
  }
  let oseq = 0;
  function order(tenant: string, status: string, credits: number, bonus: number, yuan: number, confirmedAt: number) {
    db.prepare(
      `INSERT INTO recharge_order (id,tenant_id,created_by,order_no,plan_name,price_yuan,credits,bonus_credits,status,confirmed_at,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(`ord-${++oseq}`, tenant, 'u', `NO${oseq}`, 'P', yuan, credits, bonus, status, confirmedAt, confirmedAt, confirmedAt);
  }

  beforeAll(() => {
    opsTenant = createTenant('运营A').id;
    opsTenant2 = createTenant('运营B').id;
    // 消耗:reserve −100(本月内,今天)+ release +30(退款)→ 净消耗 70。settle 写 0(应被忽略)。grant +500(不算消耗)。
    ledger(opsTenant, 'reserve', -100, today2 + 1000);
    ledger(opsTenant, 'release', 30, today2 + 2000);
    ledger(opsTenant, 'settle', 0, today2 + 3000);       // 干扰:settle 不应计入消耗
    ledger(opsTenant, 'grant', 500, today2 + 4000);      // 干扰:grant 不是消耗
    // 昨天:reserve −40
    ledger(opsTenant, 'reserve', -40, today2 - 12 * 60 * 60 * 1000);
    // 另一租户本月消耗 −200(测 Top 排序:运营B > 运营A)
    ledger(opsTenant2, 'reserve', -200, today2 + 1000);
    // 充值:credited 才算。credited 100+赠10 / ¥50;pending 不算。
    order(opsTenant, 'credited', 100, 10, 50, today2 + 5000);
    order(opsTenant, 'pending_payment', 999, 0, 999, today2 + 6000); // 干扰:未到账不算
  });

  it('消耗口径 = reserve+release(非 settle、非 grant)', async () => {
    const c = await padminLogin();
    const r = await c.get('/admin/api/metrics/ops');
    expect(r.status).toBe(200);
    // 今日消耗:运营A 70(reserve100−release30)+ 运营B 200 = 270(全租户合计)
    expect(r.body.consumption.today).toBe(270);
    // settle=0、grant=500 都没污染 → 若误用 settle 今日会是 0,误把 grant 当消耗会变负
    expect(r.body.consumption.yesterday).toBeGreaterThanOrEqual(40); // 运营A 昨日 40
    expect(r.body.consumption.month).toBeGreaterThanOrEqual(270);
  });

  it('充值口径 = recharge_order credited(非 grant、非 pending)', async () => {
    const c = await padminLogin();
    const r = await c.get('/admin/api/metrics/ops');
    // 本月充值:credited 110 积分(100+10)/ ¥50;pending 的 999 不算
    expect(r.body.recharge.credits).toBe(110);
    expect(r.body.recharge.yuan).toBe(50);
    expect(r.body.recharge.orders).toBe(1);
  });

  it('Top 消费租户:按消耗降序、JOIN 租户名', async () => {
    const c = await padminLogin();
    const r = await c.get('/admin/api/metrics/ops');
    const month = r.body.topTenants.month;
    expect(month.length).toBeGreaterThanOrEqual(2);
    expect(month[0].used).toBeGreaterThanOrEqual(month[1].used); // 降序
    const names = month.map((t: { name: string }) => t.name);
    expect(names).toContain('运营A');
    expect(names).toContain('运营B');
  });

  it('每租户余额 + 续航;无消耗租户续航为 null(防 ÷0)', async () => {
    const c = await padminLogin();
    const r = await c.get('/admin/api/metrics/ops');
    const rw = r.body.tenantRunway;
    expect(Array.isArray(rw)).toBe(true);
    // 余额升序(快断流在前)
    for (let i = 1; i < rw.length; i++) expect(rw[i].balance).toBeGreaterThanOrEqual(rw[i - 1].balance);
    // 存在一个曾有 job 但无近 7 日消耗的租户(如 tenantB,只有 job 无 ledger)→ runwayDays=null
    const noBurn = rw.find((t: { runwayDays: number | null; dailyBurn: number }) => t.dailyBurn === 0);
    if (noBurn) expect(noBurn.runwayDays).toBeNull();
  });

  it('未登录打 ops → 401', async () => {
    const r = await new Client(app).get('/admin/api/metrics/ops');
    expect(r.status).toBe(401);
  });
});

// ── 积分消耗流水 /api/consumption(对账)──
describe('积分消耗流水 consumption 端点', () => {
  let ct: string;
  let lq = 0;
  function led(tenant: string, kind: string, amount: number, jobId: string | null, createdAt: number) {
    db.prepare(`INSERT INTO credit_ledger (id,tenant_id,kind,amount,job_id,created_at) VALUES (?,?,?,?,?,?)`)
      .run(`cled-${++lq}`, tenant, kind, amount, jobId, createdAt);
  }
  function cjob(tenant: string, type: string, model: string | null, status: string, createdAt: number, startedAt: number | null, updatedAt: number) {
    const id = `cjob-${++seq}`;
    const input = model ? JSON.stringify({ model }) : '{}';
    db.prepare(
      `INSERT INTO job (id,tenant_id,type,status,progress,input_json,attempts,created_at,updated_at,started_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, tenant, type, status, status === 'done' ? 100 : 0, input, 1, createdAt, updatedAt, startedAt);
    return id;
  }

  beforeAll(() => {
    ct = createTenant('对账租户').id;
    const t0 = todayStart;
    // 任务1: ai_image / z-image / done,reserve -10 净 release +3 → 消耗 7;耗时 5s。
    const j1 = cjob(ct, 'ai_image', 'z-image', 'done', t0 + 1000, t0 + 1500, t0 + 6500);
    led(ct, 'reserve', -10, j1, t0 + 1000); led(ct, 'release', 3, j1, t0 + 2000);
    // 任务2: tts / 无 model / done,reserve -4 → 消耗 4。
    const j2 = cjob(ct, 'tts', null, 'done', t0 + 3000, t0 + 3100, t0 + 5100);
    led(ct, 'reserve', -4, j2, t0 + 3000);
    // 任务3: video_t2v / 失败,reserve -20 全 release +20 → 消耗 0(失败已退不计)。
    const j3 = cjob(ct, 'video_t2v', 'wan2.7-t2v', 'failed', t0 + 4000, t0 + 4100, t0 + 4500);
    led(ct, 'reserve', -20, j3, t0 + 4000); led(ct, 'release', 20, j3, t0 + 4500);
  });

  it('列消耗:module/model/状态/消耗积分/耗时,按时间倒序', async () => {
    const c = await padminLogin();
    const r = await c.get('/admin/api/consumption?tenant=' + ct + '&pageSize=50');
    expect(r.status).toBe(200);
    const rows = r.body.rows.filter((x: { tenantId: string }) => x.tenantId === ct);
    expect(rows.length).toBe(3);
    // 倒序:最后插入的 video_t2v(t0+4000)在最前
    expect(rows[0].module).toBe('video_t2v');
    expect(rows[0].credits).toBe(0); // 失败全退 → 0
    const z = rows.find((x: { model: string }) => x.model === 'z-image');
    expect(z.credits).toBe(7); // reserve10 净 release3
    expect(z.durationMs).toBe(5000); // done: updated-started
    const tts = rows.find((x: { module: string }) => x.module === 'tts');
    expect(tts.model).toBeNull(); // tts 无 model(前端显系统音色)
    expect(tts.credits).toBe(4);
  });

  it('分页:total + page + pageSize 正确', async () => {
    const c = await padminLogin();
    const r = await c.get('/admin/api/consumption?tenant=' + ct + '&page=1&pageSize=2');
    expect(r.body.pageSize).toBe(2);
    expect(r.body.rows.length).toBe(2);
    expect(r.body.total).toBe(3);
    const r2 = await c.get('/admin/api/consumption?tenant=' + ct + '&page=2&pageSize=2');
    expect(r2.body.rows.length).toBe(1); // 第二页剩 1 条
  });

  it('租户过滤:只返该租户的 job', async () => {
    const c = await padminLogin();
    const r = await c.get('/admin/api/consumption?tenant=' + ct + '&pageSize=100');
    expect(r.body.rows.every((x: { tenantId: string }) => x.tenantId === ct)).toBe(true);
  });

  it('未登录 → 401', async () => {
    const r = await new Client(app).get('/admin/api/consumption');
    expect(r.status).toBe(401);
  });
});
