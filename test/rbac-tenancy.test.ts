// 灵镜 Slice 2 测试 —— RBAC(验收第8条)+ 租户隔离。
//
// 验收第8条:三角色权限隔离 —— 查看者不能发起生成,创作者不能管理成员。
// 租户隔离:A 租户看不到/动不了 B 租户的任务。

import { describe, it, expect, beforeAll } from 'vitest';

process.env.DB_FILE = ':memory:';

const { createApp } = await import('../src/server.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { grant } = await import('../src/credits/index.js');
const { Client } = await import('./helpers.js');

const app = createApp();

let tenantA: string;
let tenantB: string;

// 用户名全局唯一:测试里给每个租户的账号加租户前缀,loginAs 自动拼。
const tag = (tid: string) => (tid === tenantA ? 'A' : tid === tenantB ? 'B' : 'X');

beforeAll(() => {
  tenantA = createTenant('A 台').id;
  tenantB = createTenant('B 台').id;
  createUser(tenantA, 'A_admin', 'pw123456', 'admin');
  createUser(tenantA, 'A_creator', 'pw123456', 'creator');
  createUser(tenantA, 'A_viewer', 'pw123456', 'viewer');
  createUser(tenantB, 'B_admin', 'pw123456', 'admin');
  grant(tenantA, 10000); // A 有积分,可发起生成;B 故意不发(测余额隔离/不足)
});

// 保持调用处签名不变:loginAs(tenantId, '角色'),内部拼成全局唯一用户名
async function loginAs(tenantId: string, role: string): Promise<InstanceType<typeof Client>> {
  const c = new Client(app);
  const r = await c.post('/api/login', { username: `${tag(tenantId)}_${role}`, password: 'pw123456' });
  expect(r.status).toBe(200);
  return c;
}

describe('认证', () => {
  it('密码错误 → 401', async () => {
    const c = new Client(app);
    const r = await c.post('/api/login', { username: 'A_admin', password: '错的' });
    expect(r.status).toBe(401);
  });

  it('未登录访问受保护接口 → 401', async () => {
    const c = new Client(app);
    const r = await c.get('/api/me');
    expect(r.status).toBe(401);
  });

  it('登录后 /api/me 返回角色', async () => {
    const c = await loginAs(tenantA, 'creator');
    const r = await c.get('/api/me');
    expect(r.status).toBe(200);
    expect(r.body.role).toBe('creator');
    expect(r.body.tenantId).toBe(tenantA);
  });
});

describe('RBAC 验收第8条', () => {
  it('查看者不能发起生成 → 403', async () => {
    const c = await loginAs(tenantA, 'viewer');
    const r = await c.post('/api/jobs', { avatarRef: 'preset-1', voiceRef: 'cosyvoice-v1', script: '文案' });
    expect(r.status).toBe(403);
  });

  it('创作者能发起生成 → 202', async () => {
    const c = await loginAs(tenantA, 'creator');
    const r = await c.post('/api/jobs', { avatarRef: 'preset-1', voiceRef: 'cosyvoice-v1', script: '文案' });
    expect(r.status).toBe(202);
  });

  it('创作者不能管理成员 → 403', async () => {
    const c = await loginAs(tenantA, 'creator');
    const r = await c.post('/api/members', { username: 'x', password: 'pw123456', role: 'viewer' });
    expect(r.status).toBe(403);
  });

  it('管理员能管理成员 → 201', async () => {
    const c = await loginAs(tenantA, 'admin');
    const r = await c.post('/api/members', { username: 'newbie', password: 'pw123456', role: 'viewer' });
    expect(r.status).toBe(201);
  });

  it('查看者能看作品列表 → 200', async () => {
    const c = await loginAs(tenantA, 'viewer');
    const r = await c.get('/api/jobs');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
  });
});

describe('租户隔离', () => {
  it('A 租户的任务,B 租户读不到 → 404', async () => {
    const ca = await loginAs(tenantA, 'creator');
    const created = await ca.post('/api/jobs', { avatarRef: 'preset-1', voiceRef: 'cosyvoice-v1', script: 'A 的任务' });
    expect(created.status).toBe(202);
    const jobId = created.body.id;

    // A 自己能读到
    const ownRead = await ca.get(`/api/jobs/${jobId}`);
    expect(ownRead.status).toBe(200);

    // B 读不到(404,不泄露存在性)
    const cb = await loginAs(tenantB, 'admin');
    const crossRead = await cb.get(`/api/jobs/${jobId}`);
    expect(crossRead.status).toBe(404);
  });

  it('A 租户作品列表只含自己的任务', async () => {
    const cb = await loginAs(tenantB, 'admin');
    const list = await cb.get('/api/jobs');
    expect(list.status).toBe(200);
    // B 没发起过生成任务(只在隔离测试里 A 发了),B 列表应为空
    expect(list.body.length).toBe(0);
  });
});

describe('积分 + 审计 API', () => {
  it('非 admin 不能发放积分 → 403', async () => {
    const c = await loginAs(tenantA, 'creator');
    const r = await c.post('/api/credits/grant', { amount: 100 });
    expect(r.status).toBe(403);
  });

  it('admin 发放积分 → 余额增加', async () => {
    const c = await loginAs(tenantA, 'admin');
    const before = (await c.get('/api/credits/balance')).body.balance;
    const g = await c.post('/api/credits/grant', { amount: 500 });
    expect(g.status).toBe(200);
    const after = (await c.get('/api/credits/balance')).body.balance;
    expect(after).toBe(before + 500);
  });

  it('费用预估返回 cost', async () => {
    const c = await loginAs(tenantA, 'creator');
    const r = await c.post('/api/jobs/estimate', { script: '一二三四五', resolution: '1080P' });
    expect(r.status).toBe(200);
    expect(r.body.cost).toBeGreaterThan(0);
  });

  it('余额不足时发起生成 → 402', async () => {
    // 新建一个没发过积分的租户(用户名全局唯一)
    const poorTenant = createTenant('穷台').id;
    createUser(poorTenant, 'poor_creator', 'pw123456', 'creator');
    const c = new Client(app);
    await c.post('/api/login', { username: 'poor_creator', password: 'pw123456' });
    const r = await c.post('/api/jobs', { avatarRef: 'preset-1', voiceRef: 'cosyvoice-v1', script: '需要扣分的文案' });
    expect(r.status).toBe(402);
  });

  it('admin 能看审计日志,且登录被记录', async () => {
    const c = await loginAs(tenantA, 'admin');
    const r = await c.get('/api/audit');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body.some((a: any) => a.action === 'login')).toBe(true);
  });

  it('非 admin 不能看审计 → 403', async () => {
    const c = await loginAs(tenantA, 'viewer');
    const r = await c.get('/api/audit');
    expect(r.status).toBe(403);
  });
});

describe('停用即生效', () => {
  it('管理员停用成员后,该成员 session 立即失效', async () => {
    const admin = await loginAs(tenantA, 'admin');
    // 新建一个成员并登录(用户名全局唯一)
    await admin.post('/api/members', { username: 'tobedisabled', password: 'pw123456', role: 'creator' });
    const victim = new Client(app);
    await victim.post('/api/login', { username: 'tobedisabled', password: 'pw123456' });
    expect((await victim.get('/api/me')).status).toBe(200);

    // 找到该成员 id 并停用
    const members = await admin.get('/api/members');
    const target = members.body.find((m: any) => m.username === 'tobedisabled');
    const dis = await admin.post(`/api/members/${target.id}/disable`, {});
    expect(dis.status).toBe(200);

    // 被停用者原 session 立即失效(server session 的价值,JWT 做不到)
    expect((await victim.get('/api/me')).status).toBe(401);
  });
});
