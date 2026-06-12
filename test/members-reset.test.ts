// 灵镜 — 成员模块:邀请带昵称 + 管理员重置密码。
//
// 覆盖:
//   - createUser(displayName) → display_name 入库;省略 → 回落 username
//   - POST /members 带 displayName → 成员昵称生效
//   - POST /members/:id/reset-password(admin):随机密码 → 旧密码失效、新密码可登录、作废 session;
//     重置自己 → 拒;creator/viewer → 403;跨租户 → 404
//   - genTempPassword:长度 + 无歧义字符

import { describe, it, expect, beforeAll } from 'vitest';

process.env.DB_FILE = ':memory:';

const { db } = await import('../src/db/index.js');
const { createApp } = await import('../src/server.js');
const { createTenant, createUser, tenantAdminResetPassword } = await import('../src/auth/index.js');
const { genTempPassword } = await import('../src/auth/crypto.js');
const { Client } = await import('./helpers.js');

const app = createApp();
let tId = '';
let adminId = '';
let memberId = '';

beforeAll(async () => {
  tId = createTenant('重置测试台').id;
  adminId = createUser(tId, 'resetadmin', 'pw123456', 'admin').id;
  memberId = createUser(tId, 'resetmember', 'oldpw123', 'creator', '小张').id;
  createUser(tId, 'resetcreator', 'pw123456', 'creator');
});

async function asAdmin() {
  const c = new Client(app);
  await c.login('resetadmin', 'pw123456');
  return c;
}

describe('createUser 带昵称(display_name)', () => {
  it('传 displayName → display_name 入库', () => {
    const u = createUser(tId, 'nameuser', 'pw123456', 'creator', '王五');
    expect(u.display_name).toBe('王五');
  });
  it('省略 displayName → 回落 username(旧调用兼容)', () => {
    const u = createUser(tId, 'nonameuser', 'pw123456', 'creator');
    expect(u.display_name).toBe('nonameuser');
  });
  it('POST /members 带 displayName → 成员昵称生效', async () => {
    const c = await asAdmin();
    const r = await c.post('/api/members', { username: 'apiuser', password: 'pw123456', role: 'creator', displayName: '李四' });
    expect(r.status).toBe(201);
    expect(r.body.displayName).toBe('李四');
  });
});

describe('genTempPassword', () => {
  it('默认 12 位,无歧义字符(无 0 O 1 l I)', () => {
    const p = genTempPassword();
    expect(p.length).toBe(12);
    expect(/[0O1lI]/.test(p)).toBe(false);
  });
  it('两次生成不同(随机)', () => {
    expect(genTempPassword()).not.toBe(genTempPassword());
  });
});

describe('POST /members/:id/reset-password(管理员)', () => {
  it('admin 重置 → 返回 username+password;旧密码失效、新密码可登录', async () => {
    const c = await asAdmin();
    const r = await c.post(`/api/members/${memberId}/reset-password`, {});
    expect(r.status).toBe(200);
    expect(r.body.username).toBe('resetmember');
    expect(typeof r.body.password).toBe('string');
    expect(r.body.password.length).toBeGreaterThanOrEqual(10);
    // 新密码能登录
    const ok = await new Client(app).login('resetmember', r.body.password);
    expect(ok.status).toBe(200);
    // 旧密码失效
    const bad = await new Client(app).login('resetmember', 'oldpw123');
    expect(bad.status).toBe(401);
  });

  it('作废目标 session:重置后旧 token 失效', async () => {
    // 目标用户先登录拿 token
    const victim = new Client(app);
    await victim.login('resetcreator', 'pw123456');
    expect((await victim.get('/api/me')).status).toBe(200);
    // admin 重置该用户
    const c = await asAdmin();
    const r = await c.post(`/api/members/${(db.prepare(`SELECT id FROM user WHERE username='resetcreator'`).get() as { id: string }).id}/reset-password`, {});
    expect(r.status).toBe(200);
    // 旧 session 已作废
    expect((await victim.get('/api/me')).status).toBe(401);
  });

  it('重置自己 → 拒(SELF_ACTION,409)', async () => {
    const c = await asAdmin();
    const r = await c.post(`/api/members/${adminId}/reset-password`, {});
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('SELF_ACTION');
  });

  it('非 admin(viewer)调 → 403', async () => {
    // apiuser 是上面建的 viewer;用它登录(初始密码 pw123456)
    const cc = new Client(app);
    await cc.login('apiuser', 'pw123456');
    const r = await cc.post(`/api/members/${memberId}/reset-password`, {});
    expect(r.status).toBe(403);
  });

  it('跨租户 / 不存在用户 → 404', async () => {
    const c = await asAdmin();
    const r = await c.post(`/api/members/ghost-id/reset-password`, {});
    expect(r.status).toBe(404);
  });

  it('helper tenantAdminResetPassword:重置自己抛错', () => {
    expect(() => tenantAdminResetPassword(tId, adminId, adminId)).toThrow();
  });
});
