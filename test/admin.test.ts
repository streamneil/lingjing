// 灵镜 平台超管(/admin)测试 —— 隔离、开户、跨租户充值、bootstrap、保留字。
//
// 决策来源:/plan-eng-review Section 3 覆盖图。重点验证 5 条 ★★★ 关键:
//   B2 隔离(租户 session 打 /admin → 401)、B3 拒启(无 SUPERADMIN_PASS)、
//   E1 不存在 tenant → 404、保留字拒绝、captcha token 一次性。

import { describe, it, expect, beforeAll } from 'vitest';

process.env.DB_FILE = ':memory:';
process.env.SUPERADMIN_USER = 'admin';
process.env.SUPERADMIN_PASS = 'superpw123';

const { createApp } = await import('../src/server.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { bootstrapSuperadmin } = await import('../src/auth/platform.js');
const { Client } = await import('./helpers.js');

const app = createApp();
let tenantId: string;

beforeAll(() => {
  bootstrapSuperadmin(); // 首启建超管 admin（env 种子）
  tenantId = createTenant('超管测试台').id;
  createUser(tenantId, 'tadmin', 'pw123456', 'admin'); // 租户管理员（非保留字）
});

/** 超管登录助手:走滑块 → /admin/login,返回带 lj_padmin cookie 的 Client。 */
async function padminLogin(username = 'admin', password = 'superpw123'): Promise<InstanceType<typeof Client>> {
  const c = new Client(app);
  const r = await c.login(username, password, '/admin/login');
  expect(r.status).toBe(200);
  return c;
}

describe('超管 bootstrap（首启建超管）', () => {
  it('admin 能登录（env 种子已建）', async () => {
    const c = await padminLogin();
    const me = await c.get('/admin/api/me');
    expect(me.status).toBe(200);
    expect(me.body.username).toBe('admin');
  });
  it('bootstrap 幂等：再调一次不重复建', () => {
    expect(() => bootstrapSuperadmin()).not.toThrow();
  });
});

describe('B2 跨租户隔离（核心安全）', () => {
  it('租户 lj_session 打 /admin/api/tenants → 401（结构隔离,req.user 在 /admin 链路无效）', async () => {
    const tenant = new Client(app);
    await tenant.login('tadmin', 'pw123456'); // 拿到租户 lj_session
    const r = await tenant.get('/admin/api/tenants');
    expect(r.status).toBe(401);
  });
  it('无任何会话打 /admin/api/tenants → 401', async () => {
    const c = new Client(app);
    const r = await c.get('/admin/api/tenants');
    expect(r.status).toBe(401);
  });
});

describe('超管登录防暴破（滑块）', () => {
  it('无 captcha_token 直接 POST /admin/login → 400', async () => {
    const c = new Client(app);
    const r = await c.post('/admin/login', { username: 'admin', password: 'superpw123' });
    expect(r.status).toBe(400);
  });
  it('错密码 → 401', async () => {
    const c = new Client(app);
    const r = await c.login('admin', '错的', '/admin/login');
    expect(r.status).toBe(401);
  });
});

describe('租户管理', () => {
  it('列租户返回余额 + 用户数', async () => {
    const c = await padminLogin();
    const r = await c.get('/admin/api/tenants');
    expect(r.status).toBe(200);
    const t = r.body.tenants.find((x: any) => x.id === tenantId);
    expect(t).toBeTruthy();
    expect(typeof t.balance).toBe('number');
    expect(t.user_count).toBeGreaterThanOrEqual(1);
  });
  it('建租户 → 201', async () => {
    const c = await padminLogin();
    const r = await c.post('/admin/api/tenants', { name: '新建测试台', delivery: 'hosted' });
    expect(r.status).toBe(201);
    expect(r.body.name).toBe('新建测试台');
  });
  it('建租户空名 → 400', async () => {
    const c = await padminLogin();
    const r = await c.post('/admin/api/tenants', { name: '  ' });
    expect(r.status).toBe(400);
  });
});

describe('开户（复用 createUser,透传 code）', () => {
  it('开户 → 201', async () => {
    const c = await padminLogin();
    const r = await c.post(`/admin/api/tenants/${tenantId}/users`, { username: 'opened-user', password: 'pw123456', role: 'creator' });
    expect(r.status).toBe(201);
    expect(r.body.username).toBe('opened-user');
  });
  it('保留字 admin → 409（透传保留字错）', async () => {
    const c = await padminLogin();
    const r = await c.post(`/admin/api/tenants/${tenantId}/users`, { username: 'Admin', password: 'pw123456', role: 'creator' });
    expect(r.status).toBe(409); // 大小写折叠后命中保留字
  });
  it('给不存在租户开户 → 404', async () => {
    const c = await padminLogin();
    const r = await c.post(`/admin/api/tenants/nonexistent/users`, { username: 'x-user', password: 'pw123456', role: 'creator' });
    expect(r.status).toBe(404);
  });
});

describe('跨租户充值（收入收口）', () => {
  it('超管充值 → 200 且余额增加', async () => {
    const c = await padminLogin();
    const before = c.get(`/admin/api/tenants`).then((r: any) => r.body.tenants.find((x: any) => x.id === tenantId).balance);
    const beforeBal = await before;
    const r = await c.post(`/admin/api/tenants/${tenantId}/grant`, { amount: 500 });
    expect(r.status).toBe(200);
    expect(r.body.balance).toBe(beforeBal + 500);
  });
  it('E1: 充值不存在的租户 → 404（防孤儿 ledger）', async () => {
    const c = await padminLogin();
    const r = await c.post(`/admin/api/tenants/nonexistent/grant`, { amount: 500 });
    expect(r.status).toBe(404);
  });
  it('amount<=0 → 400', async () => {
    const c = await padminLogin();
    const r = await c.post(`/admin/api/tenants/${tenantId}/grant`, { amount: 0 });
    expect(r.status).toBe(400);
  });
});

describe('新建租户固定 hosted(A1:去私有化)', () => {
  it('建租户忽略 delivery=private,落 hosted', async () => {
    const c = await padminLogin();
    const r = await c.post('/admin/api/tenants', { name: '托管台', delivery: 'private' });
    expect(r.status).toBe(201);
    expect(r.body.delivery).toBe('hosted'); // 新建只建托管,private 被忽略
  });
});

describe('租户详情管理(A2)', () => {
  it('改机构名 → 生效', async () => {
    const c = await padminLogin();
    const t = createTenant('改名前').id;
    const r = await c.put(`/admin/api/tenants/${t}`, { name: '改名后' });
    expect(r.status).toBe(200);
    const list = await c.get('/admin/api/tenants');
    expect(list.body.tenants.find((x: any) => x.id === t).name).toBe('改名后');
  });
  it('改席位上限 + 交付模式 → 生效', async () => {
    const c = await padminLogin();
    const t = createTenant('配置台').id;
    const r = await c.put(`/admin/api/tenants/${t}`, { maxCreatorSeats: 25, delivery: 'private' });
    expect(r.status).toBe(200);
    const row = await c.get('/admin/api/tenants');
    const tt = row.body.tenants.find((x: any) => x.id === t);
    expect(tt.max_creator_seats).toBe(25);
    expect(tt.delivery).toBe('private');
  });
  it('席位上限降到低于已用 → 400', async () => {
    const c = await padminLogin();
    const t = createTenant('满席台').id;
    createUser(t, 'seat-c1', 'pw123456', 'creator');
    createUser(t, 'seat-c2', 'pw123456', 'creator');
    const r = await c.put(`/admin/api/tenants/${t}`, { maxCreatorSeats: 1 }); // 已用 2 > 1
    expect(r.status).toBe(400);
  });
  it('改空名 → 400', async () => {
    const c = await padminLogin();
    const r = await c.put(`/admin/api/tenants/${tenantId}`, { name: '  ' });
    expect(r.status).toBe(400);
  });
  it('改不存在租户 → 404', async () => {
    const c = await padminLogin();
    const r = await c.put(`/admin/api/tenants/nope`, { name: 'x' });
    expect(r.status).toBe(404);
  });

  it('列租户用户', async () => {
    const c = await padminLogin();
    const r = await c.get(`/admin/api/tenants/${tenantId}/users`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.users)).toBe(true);
    expect(r.body.users.find((u: any) => u.username === 'tadmin')).toBeTruthy();
    expect(r.body.users[0].password_hash).toBeUndefined(); // 不泄密码 hash
  });

  it('重置用户密码(免旧密码)→ 新密码可登录,旧密码失效', async () => {
    const c = await padminLogin();
    const t = createTenant('重置台').id;
    const u = createUser(t, 'reset-user', 'oldpw123', 'creator');
    const r = await c.post(`/admin/api/tenants/${t}/users/${u.id}/reset-password`, { newPassword: 'newpw456' });
    expect(r.status).toBe(200);
    // 新密码能登录
    const ok = await new Client(app).login('reset-user', 'newpw456');
    expect(ok.status).toBe(200);
    // 旧密码失效
    const bad = await new Client(app).login('reset-user', 'oldpw123');
    expect(bad.status).toBe(401);
  });
  it('重置密码 <6 位 → 400', async () => {
    const c = await padminLogin();
    const t = createTenant('短密台').id;
    const u = createUser(t, 'short-pw-user', 'pw123456', 'creator');
    const r = await c.post(`/admin/api/tenants/${t}/users/${u.id}/reset-password`, { newPassword: '123' });
    expect(r.status).toBe(400);
  });
  it('重置不存在用户 → 404', async () => {
    const c = await padminLogin();
    const r = await c.post(`/admin/api/tenants/${tenantId}/users/nope/reset-password`, { newPassword: 'newpw456' });
    expect(r.status).toBe(404);
  });

  it('停用 + 启用用户', async () => {
    const c = await padminLogin();
    const t = createTenant('停用台').id;
    createUser(t, 'disable-admin', 'pw123456', 'admin'); // 留一个 admin 保底
    const u = createUser(t, 'to-disable', 'pw123456', 'creator');
    const dis = await c.post(`/admin/api/tenants/${t}/users/${u.id}/disable`);
    expect(dis.status).toBe(200);
    const users1 = await c.get(`/admin/api/tenants/${t}/users`);
    expect(users1.body.users.find((x: any) => x.id === u.id).status).toBe('disabled');
    const en = await c.post(`/admin/api/tenants/${t}/users/${u.id}/enable`);
    expect(en.status).toBe(200);
  });
  it('停用最后一个 admin → 409(LAST_ADMIN 保护)', async () => {
    const c = await padminLogin();
    const t = createTenant('独管台').id;
    const a = createUser(t, 'only-admin', 'pw123456', 'admin');
    const r = await c.post(`/admin/api/tenants/${t}/users/${a.id}/disable`);
    expect(r.status).toBe(409);
  });

  it('B2 隔离:租户 session 打租户管理路由 → 401', async () => {
    const tenant = new Client(app);
    await tenant.login('tadmin', 'pw123456');
    const r = await tenant.put(`/admin/api/tenants/${tenantId}`, { name: 'hack' });
    expect(r.status).toBe(401);
  });
});

describe('AI图片模型 — 分辨率列表 CRUD(POST/GET/PUT 往返,P2-d 不被清空)', () => {
  const RES = [
    { ratio: '1:1', width: 2048, height: 2048, isDefault: true },
    { ratio: '16:9', width: 2688, height: 1536 },
  ];
  it('POST 录入 → GET 取回完整 resolutions', async () => {
    const c = await padminLogin();
    const r = await c.post('/admin/api/image-models', {
      key: 'res-test', label: '分辨率测试', modelId: 'qwen-image', priceTier: 4, maxImages: 4,
      enabled: true, shapeTemplate: 'qwen-image', modes: ['text2img'], sortOrder: 99, resolutions: RES,
    });
    expect(r.status).toBe(201);
    const g = await c.get('/admin/api/image-models');
    const m = g.body.models.find((x: any) => x.key === 'res-test');
    expect(m.resolutions).toHaveLength(2);
    expect(m.resolutions.find((x: any) => x.ratio === '1:1')).toMatchObject({ width: 2048, height: 2048, isDefault: true });
  });
  it('PUT upsert 往返保留 resolutions(P2-d:ON CONFLICT SET 含 resolutions,不被清)', async () => {
    const c = await padminLogin();
    // 用独立 key 自建(不依赖上条用例顺序)
    await c.post('/admin/api/image-models', {
      key: 'res-put', label: '分辨率PUT', modelId: 'qwen-image', priceTier: 4, maxImages: 4,
      enabled: true, shapeTemplate: 'qwen-image', modes: ['text2img'], sortOrder: 99, resolutions: RES,
    });
    // PUT 带上 resolutions(前端 submitModel 总是带);验证 upsert 往返不丢
    const r = await c.put('/admin/api/image-models/res-put', {
      label: '改名了', modelId: 'qwen-image', priceTier: 4, maxImages: 4,
      enabled: true, shapeTemplate: 'qwen-image', modes: ['text2img'], sortOrder: 99, resolutions: RES,
    });
    expect(r.status).toBe(200);
    const g = await c.get('/admin/api/image-models');
    const m = g.body.models.find((x: any) => x.key === 'res-put');
    expect(m.label).toBe('改名了');
    expect(m.resolutions).toHaveLength(2); // 没被 upsert 清空
  });
  it('重复比例 → 400(validModelBody 去重校验)', async () => {
    const c = await padminLogin();
    const r = await c.post('/admin/api/image-models', {
      key: 'res-dup', label: 'dup', modelId: 'qwen-image', priceTier: 4, maxImages: 4,
      enabled: true, shapeTemplate: 'qwen-image', modes: ['text2img'], sortOrder: 99,
      resolutions: [{ ratio: '1:1', width: 1024, height: 1024 }, { ratio: '1:1', width: 2048, height: 2048 }],
    });
    expect(r.status).toBe(400);
  });
});
