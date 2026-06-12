// 灵镜 意向线索测试 —— POST /api/sales-leads(kind 三态 + 快照 + 60s 幂等)+ admin 列表/改状态。
//
// 设计来源:/plan-eng-review。覆盖:kind=plan/enterprise/topup 分支、快照含 credits+bonus、
//   60s 幂等(不过滤 status)、updateLeadStatus 越界、删套餐后快照保留、鉴权隔离。

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

process.env.DB_FILE = ':memory:';
process.env.SUPERADMIN_USER = 'admin';
process.env.SUPERADMIN_PASS = 'superpw123';

const { createApp } = await import('../src/server.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { bootstrapSuperadmin } = await import('../src/auth/platform.js');
const { db } = await import('../src/db/index.js');
const pricing = await import('../src/pricing/index.js');
const { Client } = await import('./helpers.js');

const app = createApp();
let tenantId: string;
let planId: string;

async function padminLogin(): Promise<InstanceType<typeof Client>> {
  const c = new Client(app);
  const r = await c.login('admin', 'superpw123', '/admin/login');
  expect(r.status).toBe(200);
  return c;
}
async function tenantLogin(): Promise<InstanceType<typeof Client>> {
  const c = new Client(app);
  const r = await c.login('lead-user', 'pw123456');
  expect(r.status).toBe(200);
  return c;
}

beforeAll(() => {
  bootstrapSuperadmin();
  tenantId = createTenant('线索测试台').id;
  createUser(tenantId, 'lead-user', 'pw123456', 'creator');
});

beforeEach(() => {
  db.prepare(`DELETE FROM sales_leads`).run();
  db.prepare(`DELETE FROM pricing_plan`).run();
  planId = pricing.createPlan({
    name: '标准', priceYuan: 1000, credits: 100000, bonusCredits: 5000,
  }).id;
});

describe('鉴权', () => {
  it('未登录 POST → 401', async () => {
    const c = new Client(app);
    expect((await c.post('/api/sales-leads', { kind: 'plan', planId })).status).toBe(401);
  });
});

describe('kind=plan:套餐购买 + 快照', () => {
  it('成功 201 + 落库含 credits/bonus 快照', async () => {
    const t = await tenantLogin();
    const r = await t.post('/api/sales-leads', { kind: 'plan', planId });
    expect(r.status).toBe(201);
    const row = db.prepare(`SELECT * FROM sales_leads WHERE id=?`).get(r.body.leadId) as any;
    expect(row.user_id).toBeTruthy();
    expect(row.tenant_id).toBe(tenantId);
    expect(row.plan_id).toBe(planId);
    expect(row.plan_name).toBe('标准');
    expect(row.plan_price_yuan).toBe(1000);
    expect(row.plan_credits).toBe(100000);
    expect(row.plan_bonus_credits).toBe(5000);
    expect(row.status).toBe('new');
  });
  it('缺 planId → 400', async () => {
    const t = await tenantLogin();
    expect((await t.post('/api/sales-leads', { kind: 'plan' })).status).toBe(400);
  });
  it('停用套餐 → 400', async () => {
    pricing.updatePlan(planId, { name: '标准', priceYuan: 1000, credits: 100000, enabled: false });
    const t = await tenantLogin();
    expect((await t.post('/api/sales-leads', { kind: 'plan', planId })).status).toBe(400);
  });
});

describe('kind=enterprise/topup:无套餐 + note 必填', () => {
  it('enterprise 带 note 成功', async () => {
    const t = await tenantLogin();
    const r = await t.post('/api/sales-leads', { kind: 'enterprise', note: '需私有化部署' });
    expect(r.status).toBe(201);
    const row = db.prepare(`SELECT * FROM sales_leads WHERE id=?`).get(r.body.leadId) as any;
    expect(row.plan_id).toBeNull();
    expect(row.note).toBe('需私有化部署');
  });
  it('topup 缺 note → 400', async () => {
    const t = await tenantLogin();
    expect((await t.post('/api/sales-leads', { kind: 'topup' })).status).toBe(400);
  });
  it('enterprise 误带 planId → 400(不静默忽略)', async () => {
    const t = await tenantLogin();
    expect((await t.post('/api/sales-leads', { kind: 'enterprise', planId, note: 'x' })).status).toBe(400);
  });
  it('无效 kind → 400', async () => {
    const t = await tenantLogin();
    expect((await t.post('/api/sales-leads', { kind: 'bogus' })).status).toBe(400);
  });
});

describe('60s 幂等(不过滤 status)', () => {
  it('同 user+plan+kind 60s 内重复 → 返同一 lead,不重复落库', async () => {
    const t = await tenantLogin();
    const r1 = await t.post('/api/sales-leads', { kind: 'plan', planId });
    const r2 = await t.post('/api/sales-leads', { kind: 'plan', planId });
    expect(r1.body.leadId).toBe(r2.body.leadId);
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM sales_leads`).get() as any).n;
    expect(n).toBe(1);
  });
  it('运营改成 contacted 后 60s 内再点 → 仍幂等不新增(去 status 过滤的关键)', async () => {
    const t = await tenantLogin();
    const r1 = await t.post('/api/sales-leads', { kind: 'plan', planId });
    pricing.updateLeadStatus(r1.body.leadId, 'contacted');
    const r2 = await t.post('/api/sales-leads', { kind: 'plan', planId });
    expect(r2.body.leadId).toBe(r1.body.leadId);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM sales_leads`).get() as any).n).toBe(1);
  });
});

describe('删套餐后线索快照保留', () => {
  it('删套餐 → 线索仍能读出 plan_name/price/credits', async () => {
    const t = await tenantLogin();
    const r = await t.post('/api/sales-leads', { kind: 'plan', planId });
    pricing.deletePlan(planId);
    const row = db.prepare(`SELECT * FROM sales_leads WHERE id=?`).get(r.body.leadId) as any;
    expect(row.plan_name).toBe('标准');
    expect(row.plan_credits).toBe(100000);
  });
});

describe('admin 线索列表 + 改状态', () => {
  it('未登录/租户打 admin 线索 → 401', async () => {
    const c = new Client(app);
    expect((await c.get('/admin/api/sales-leads')).status).toBe(401);
    const t = await tenantLogin();
    expect((await t.get('/admin/api/sales-leads')).status).toBe(401);
  });
  it('超管列线索 + status 过滤 + 改状态', async () => {
    const t = await tenantLogin();
    const r = await t.post('/api/sales-leads', { kind: 'plan', planId });
    const c = await padminLogin();
    const all = await c.get('/admin/api/sales-leads');
    expect(all.body.leads.find((l: any) => l.id === r.body.leadId)).toBeTruthy();
    // 改状态
    const u = await c.put(`/admin/api/sales-leads/${r.body.leadId}`, { status: 'contacted', note: '已电话' });
    expect(u.status).toBe(200);
    const filtered = await c.get('/admin/api/sales-leads?status=contacted');
    expect(filtered.body.leads.find((l: any) => l.id === r.body.leadId)).toBeTruthy();
    const newOnly = await c.get('/admin/api/sales-leads?status=new');
    expect(newOnly.body.leads.find((l: any) => l.id === r.body.leadId)).toBeUndefined();
  });
  it('改状态越界 → 400', async () => {
    const c = await padminLogin();
    const t = await tenantLogin();
    const r = await t.post('/api/sales-leads', { kind: 'plan', planId });
    expect((await c.put(`/admin/api/sales-leads/${r.body.leadId}`, { status: 'bogus' })).status).toBe(400);
  });
  it('改不存在线索 → 404', async () => {
    const c = await padminLogin();
    expect((await c.put('/admin/api/sales-leads/nope', { status: 'closed' })).status).toBe(404);
  });
});

describe('监控 overview 含 newLeads 计数', () => {
  it('new 线索数反映到监控', async () => {
    const t = await tenantLogin();
    await t.post('/api/sales-leads', { kind: 'enterprise', note: 'a' });
    await t.post('/api/sales-leads', { kind: 'topup', note: 'b' });
    const c = await padminLogin();
    const ov = await c.get('/admin/api/metrics/overview');
    expect(ov.body.newLeads).toBe(2);
  });
});
