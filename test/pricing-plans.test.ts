// 灵镜 定价套餐测试 —— pricing/index.ts 数据层 + admin CRUD/reorder + 租户读 + 鉴权隔离。
//
// 设计来源:/plan-eng-review。覆盖:排序/enabledOnly、校验(含 price null=面议)、
//   reorder 事务、features JSON 往返、admin 全 requirePlatformAdmin、GET /api/pricing-plans requireAuth。

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

async function padminLogin(): Promise<InstanceType<typeof Client>> {
  const c = new Client(app);
  const r = await c.login('admin', 'superpw123', '/admin/login');
  expect(r.status).toBe(200);
  return c;
}
async function tenantLogin(): Promise<InstanceType<typeof Client>> {
  const c = new Client(app);
  const r = await c.login('plan-user', 'pw123456');
  expect(r.status).toBe(200);
  return c;
}

beforeAll(() => {
  bootstrapSuperadmin();
  tenantId = createTenant('定价测试台').id;
  createUser(tenantId, 'plan-user', 'pw123456', 'admin');
});

beforeEach(() => {
  db.prepare(`DELETE FROM pricing_plan`).run();
});

describe('数据层:listPlans 排序 + enabledOnly', () => {
  it('按 sort_order 排序;enabledOnly 只返启用', () => {
    const a = pricing.createPlan({ name: 'A', priceYuan: 500, credits: 50000 });
    const b = pricing.createPlan({ name: 'B', priceYuan: 1000, credits: 100000 });
    const c = pricing.createPlan({ name: 'C', priceYuan: 5000, credits: 500000, enabled: false });
    // 默认 sort_order 按创建顺序递增
    expect(pricing.listPlans().map((p) => p.name)).toEqual(['A', 'B', 'C']);
    // 停用 C 不在 enabledOnly
    expect(pricing.listPlans({ enabledOnly: true }).map((p) => p.name)).toEqual(['A', 'B']);
    void a; void b; void c;
  });
});

describe('数据层:校验', () => {
  it('name 空 → 抛', () => {
    expect(() => pricing.createPlan({ name: '  ', priceYuan: 500, credits: 50000 })).toThrow();
  });
  it('credits ≤0 → 抛', () => {
    expect(() => pricing.createPlan({ name: 'X', priceYuan: 500, credits: 0 })).toThrow();
  });
  it('price_yuan = null(面议)合法', () => {
    const p = pricing.createPlan({ name: '面议套餐', priceYuan: null, credits: 99999 });
    expect(p.price_yuan).toBeNull();
  });
  it('price_yuan 负数 → 抛', () => {
    expect(() => pricing.createPlan({ name: 'X', priceYuan: -1, credits: 50000 })).toThrow();
  });
});

describe('数据层:features JSON 往返 + reorder 事务', () => {
  it('features 存数组 → 读回数组', () => {
    const p = pricing.createPlan({
      name: 'F',
      priceYuan: 500,
      credits: 50000,
      features: ['有效期1年', '专属对接'],
    });
    expect(pricing.parseFeatures(p.features)).toEqual(['有效期1年', '专属对接']);
  });
  it('reorderPlans 事务:乱序 ids → sort_order 重写', () => {
    const a = pricing.createPlan({ name: 'A', priceYuan: 1, credits: 1 });
    const b = pricing.createPlan({ name: 'B', priceYuan: 1, credits: 1 });
    const c = pricing.createPlan({ name: 'C', priceYuan: 1, credits: 1 });
    pricing.reorderPlans([c.id, a.id, b.id]);
    expect(pricing.listPlans().map((p) => p.name)).toEqual(['C', 'A', 'B']);
  });
});

describe('admin API:CRUD + reorder 鉴权', () => {
  it('未登录打 admin 套餐 → 401', async () => {
    const c = new Client(app);
    expect((await c.get('/admin/api/pricing-plans')).status).toBe(401);
  });
  it('租户 session 打 admin 套餐 → 401(结构隔离)', async () => {
    const t = await tenantLogin();
    expect((await t.get('/admin/api/pricing-plans')).status).toBe(401);
  });
  it('超管 CRUD 往返 + 前台即时生效', async () => {
    const c = await padminLogin();
    // 创建
    const r = await c.post('/admin/api/pricing-plans', {
      name: '标准', priceYuan: 1000, credits: 100000, bonusCredits: 5000,
      flag: '最受欢迎', features: ['有效期1年'], enabled: true,
    });
    expect(r.status).toBe(201);
    const id = r.body.id;
    // admin 列含停用全集
    const list = await c.get('/admin/api/pricing-plans');
    expect(list.body.plans.find((p: any) => p.id === id).name).toBe('标准');
    // 改
    const u = await c.put(`/admin/api/pricing-plans/${id}`, {
      name: '标准改', priceYuan: 1200, credits: 100000, enabled: true,
    });
    expect(u.status).toBe(200);
    // 停用 → 前台不显
    await c.put(`/admin/api/pricing-plans/${id}`, { name: '标准改', priceYuan: 1200, credits: 100000, enabled: false });
    const tenant = await tenantLogin();
    const pub = await tenant.get('/api/pricing-plans');
    expect(pub.body.plans.find((p: any) => p.id === id)).toBeUndefined();
    // 删
    const d = await c.del(`/admin/api/pricing-plans/${id}`);
    expect(d.status).toBe(200);
  });
  it('创建非法(credits=0)→ 400 透传 code', async () => {
    const c = await padminLogin();
    const r = await c.post('/admin/api/pricing-plans', { name: 'X', priceYuan: 500, credits: 0 });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('BAD_CREDITS');
  });
  it('reorder 生效到前台排序', async () => {
    const c = await padminLogin();
    const ra = await c.post('/admin/api/pricing-plans', { name: 'P1', priceYuan: 1, credits: 1 });
    const rb = await c.post('/admin/api/pricing-plans', { name: 'P2', priceYuan: 1, credits: 1 });
    await c.post('/admin/api/pricing-plans/reorder', { ids: [rb.body.id, ra.body.id] });
    const tenant = await tenantLogin();
    const pub = await tenant.get('/api/pricing-plans');
    expect(pub.body.plans.map((p: any) => p.name)).toEqual(['P2', 'P1']);
  });
  it('改不存在套餐 → 404', async () => {
    const c = await padminLogin();
    expect((await c.put('/admin/api/pricing-plans/nope', { name: 'X', priceYuan: 1, credits: 1 })).status).toBe(404);
  });
});

describe('租户 API:GET /api/pricing-plans requireAuth', () => {
  it('未登录 → 401(非公开读)', async () => {
    const c = new Client(app);
    expect((await c.get('/api/pricing-plans')).status).toBe(401);
  });
  it('登录后只返启用 + features 数组 + price null 透传', async () => {
    pricing.createPlan({ name: '启用', priceYuan: null, credits: 50000, features: ['面议'] });
    pricing.createPlan({ name: '停用', priceYuan: 500, credits: 50000, enabled: false });
    const t = await tenantLogin();
    const r = await t.get('/api/pricing-plans');
    expect(r.status).toBe(200);
    expect(r.body.plans).toHaveLength(1);
    expect(r.body.plans[0].name).toBe('启用');
    expect(r.body.plans[0].priceYuan).toBeNull();
    expect(r.body.plans[0].features).toEqual(['面议']);
  });
});

// 公开价格接口(营销落地页用)。设计来源:plan-eng-review —— landing.html 匿名页不能用
// requireAuth 的 /pricing-plans;此接口无鉴权、带 Cache-Control、与登录版共用 serializePlan。
describe('公开 API:GET /api/public-pricing-plans', () => {
  it('匿名(无 session)→ 200 + 启用套餐(对照 /pricing-plans 仍 401)', async () => {
    pricing.createPlan({ name: '入门体验', priceYuan: 100, credits: 800, features: ['有效期1年'] });
    const c = new Client(app);
    const r = await c.get('/api/public-pricing-plans');
    expect(r.status).toBe(200);
    expect(r.body.plans).toHaveLength(1);
    expect(r.body.plans[0].name).toBe('入门体验');
    // 同一匿名客户端打 requireAuth 版仍 401 —— 证明公开版确实免鉴权
    expect((await c.get('/api/pricing-plans')).status).toBe(401);
  });
  it('只返 enabledOnly(停用套餐不出现)', async () => {
    pricing.createPlan({ name: '启用档', priceYuan: 500, credits: 50000 });
    pricing.createPlan({ name: '停用档', priceYuan: 1000, credits: 100000, enabled: false });
    const r = await new Client(app).get('/api/public-pricing-plans');
    expect(r.body.plans.map((p: any) => p.name)).toEqual(['启用档']);
  });
  it('响应带 Cache-Control: public, max-age=30', async () => {
    pricing.createPlan({ name: 'X', priceYuan: 1, credits: 1 });
    const r = await new Client(app).get('/api/public-pricing-plans');
    expect(r.headers!['cache-control']).toBe('public, max-age=30');
  });
  it('回归:公开版与登录版输出形状一致(serializePlan 抽取后)', async () => {
    pricing.createPlan({ name: '专业', priceYuan: 1000, credits: 100000, bonusCredits: 5000, flag: '最受欢迎', features: ['有效期1年'] });
    const pub = await new Client(app).get('/api/public-pricing-plans');
    const auth = await (await tenantLogin()).get('/api/pricing-plans');
    expect(pub.body.plans).toEqual(auth.body.plans);
    // 关键展示字段健在(eng-review:别丢 flag/priceYuan)
    const p = pub.body.plans[0];
    expect(Object.keys(p).sort()).toEqual(
      ['bonusCredits', 'credits', 'features', 'flag', 'id', 'name', 'priceYuan', 'validityMonths'].sort(),
    );
    expect(p.flag).toBe('最受欢迎');
  });
});
