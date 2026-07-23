// 灵镜 Open API — key 管理 REST 端点(PR1 T6a,设计文档 §4.7)。
//
// 供设置页用(cookie session):
//   - POST /api/api-keys {name} → 创建,明文只此一次返回;任意角色可为自己建
//   - GET /api/api-keys → 成员看自己的;admin 看全租户(带 owner_name)
//   - DELETE /api/api-keys/:id → 成员吊自己的;admin 吊任意;吊销后 key 失效
//   - 作用域:API key 自身不能管理 key(/api/api-keys 不在白名单 → 403 SCOPE_FORBIDDEN)
//   - 审计:创建/吊销各写一条 audit

import { describe, it, expect, beforeAll } from 'vitest';

process.env.DB_FILE = ':memory:';

const { createApp } = await import('../src/server.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { createApiKey, resolveApiKey } = await import('../src/auth/api-keys.js');
const { listAudit } = await import('../src/audit/index.js');
const { Client } = await import('./helpers.js');

const app = createApp();

let tId = '';
let adminId = '';
let creatorId = '';
const admin = new Client(app);
const creator = new Client(app);

beforeAll(async () => {
  tId = createTenant('key 管理台').id;
  adminId = (await createUser(tId, 'mgadmin', 'pw123456', 'admin')).id;
  creatorId = (await createUser(tId, 'mgcreator', 'pw123456', 'creator')).id;
  expect((await admin.login('mgadmin', 'pw123456')).status).toBe(200);
  expect((await creator.login('mgcreator', 'pw123456')).status).toBe(200);
  void adminId; void creatorId;
}, 30000);

describe('POST /api/api-keys(创建)', () => {
  it('创建返回明文(一次)+ 前缀 + id;明文可直接认证', async () => {
    const r = await creator.post('/api/api-keys', { name: '我的 Claude Code' });
    expect(r.status).toBe(201);
    expect(r.body.key).toMatch(/^lj_sk_/);
    expect(r.body.prefix).toBe(r.body.key.slice(0, 12));
    expect(r.body.id).toBeTruthy();
    expect(r.body.name).toBe('我的 Claude Code');
    // 明文即可认证(端到端闭环)
    expect(resolveApiKey(`Bearer ${r.body.key}`)!.id).toBe(creatorId);
  });

  it('缺 name / 空 name → 400', async () => {
    expect((await creator.post('/api/api-keys', {})).status).toBe(400);
    expect((await creator.post('/api/api-keys', { name: '   ' })).status).toBe(400);
  });

  it('创建写审计', async () => {
    await creator.post('/api/api-keys', { name: 'audited' });
    const rows = listAudit(tId, 50, creatorId, false) as { action: string }[];
    expect(rows.some((a) => a.action === 'create_api_key')).toBe(true);
  });
});

describe('GET /api/api-keys(列表)', () => {
  it('成员只看自己的;列表不含明文/哈希', async () => {
    const mine = await creator.post('/api/api-keys', { name: 'list-mine' });
    const r = await creator.get('/api/api-keys');
    expect(r.status).toBe(200);
    const ids = r.body.keys.map((k: { id: string }) => k.id);
    expect(ids).toContain(mine.body.id);
    const row = r.body.keys.find((k: { id: string }) => k.id === mine.body.id);
    expect(row.key).toBeUndefined();
    expect(row.key_hash).toBeUndefined();
    expect(row.key_prefix).toMatch(/^lj_sk_/);
  });

  it('admin 看全租户 + owner_name', async () => {
    const creatorKey = await creator.post('/api/api-keys', { name: 'creator-visible-to-admin' });
    const r = await admin.get('/api/api-keys');
    expect(r.status).toBe(200);
    const row = r.body.keys.find((k: { id: string }) => k.id === creatorKey.body.id);
    expect(row).toBeTruthy(); // admin 看得到 creator 的
    expect(row.owner_name).toBe('mgcreator'); // 谁的 key 一目了然
  });

  it('成员看不到别人的 key', async () => {
    const adminKey = await admin.post('/api/api-keys', { name: 'admin-only' });
    const r = await creator.get('/api/api-keys');
    const ids = r.body.keys.map((k: { id: string }) => k.id);
    expect(ids).not.toContain(adminKey.body.id);
  });
});

describe('POST /api/api-keys/:id/disable(禁用 · 软,留痕)', () => {
  it('成员禁用自己的 → 200,key 立即失效,行仍在列表(状态已禁用)', async () => {
    const k = await creator.post('/api/api-keys', { name: 'to-disable' });
    const plain = k.body.key;
    expect(resolveApiKey(`Bearer ${plain}`)).not.toBeNull();
    const r = await creator.post(`/api/api-keys/${k.body.id}/disable`);
    expect(r.status).toBe(200);
    expect(resolveApiKey(`Bearer ${plain}`)).toBeNull();
    // 行仍在(留痕),revoked_at 非空
    const list = await creator.get('/api/api-keys');
    const row = list.body.keys.find((x: { id: string }) => x.id === k.body.id);
    expect(row).toBeTruthy();
    expect(row.revoked_at).toBeTruthy();
  });

  it('成员禁用别人的 → 404;admin 禁用任意 → 200', async () => {
    const adminKey = await admin.post('/api/api-keys', { name: 'disable-perm' });
    expect((await creator.post(`/api/api-keys/${adminKey.body.id}/disable`)).status).toBe(404);
    expect(resolveApiKey(`Bearer ${adminKey.body.key}`)).not.toBeNull();
    const creatorKey = await creator.post('/api/api-keys', { name: 'admin-disables' });
    expect((await admin.post(`/api/api-keys/${creatorKey.body.id}/disable`)).status).toBe(200);
    expect(resolveApiKey(`Bearer ${creatorKey.body.key}`)).toBeNull();
  });

  it('禁用写审计', async () => {
    const k = await creator.post('/api/api-keys', { name: 'audit-disable' });
    await creator.post(`/api/api-keys/${k.body.id}/disable`);
    const rows = listAudit(tId, 50, creatorId, false) as { action: string }[];
    expect(rows.some((a) => a.action === 'disable_api_key')).toBe(true);
  });
});

describe('DELETE /api/api-keys/:id(删除 · 硬,移除行)', () => {
  it('成员删除自己的 → 200,key 失效且行从列表消失', async () => {
    const k = await creator.post('/api/api-keys', { name: 'to-delete' });
    const plain = k.body.key;
    const r = await creator.del(`/api/api-keys/${k.body.id}`);
    expect(r.status).toBe(200);
    expect(resolveApiKey(`Bearer ${plain}`)).toBeNull();
    const list = await creator.get('/api/api-keys');
    expect(list.body.keys.find((x: { id: string }) => x.id === k.body.id)).toBeUndefined();
  });

  it('成员删除别人的 → 404;admin 删除任意 → 200', async () => {
    const adminKey = await admin.post('/api/api-keys', { name: 'del-perm' });
    expect((await creator.del(`/api/api-keys/${adminKey.body.id}`)).status).toBe(404);
    expect(resolveApiKey(`Bearer ${adminKey.body.key}`)).not.toBeNull();
    const creatorKey = await creator.post('/api/api-keys', { name: 'admin-deletes' });
    expect((await admin.del(`/api/api-keys/${creatorKey.body.id}`)).status).toBe(200);
    expect(resolveApiKey(`Bearer ${creatorKey.body.key}`)).toBeNull();
  });

  it('已禁用的 key 也能删除(先禁用再删除)', async () => {
    const k = await creator.post('/api/api-keys', { name: 'disable-then-delete' });
    expect((await creator.post(`/api/api-keys/${k.body.id}/disable`)).status).toBe(200);
    expect((await creator.del(`/api/api-keys/${k.body.id}`)).status).toBe(200);
    const list = await creator.get('/api/api-keys');
    expect(list.body.keys.find((x: { id: string }) => x.id === k.body.id)).toBeUndefined();
  });

  it('删除写审计', async () => {
    const k = await creator.post('/api/api-keys', { name: 'audit-delete' });
    await creator.del(`/api/api-keys/${k.body.id}`);
    const rows = listAudit(tId, 50, creatorId, false) as { action: string }[];
    expect(rows.some((a) => a.action === 'delete_api_key')).toBe(true);
  });
});

describe('作用域:API key 不能管理 key', () => {
  it('用 API key 访问 /api/api-keys → 403 SCOPE_FORBIDDEN', async () => {
    const key = createApiKey(tId, creatorId, 'self-mgmt-guard').key;
    const bare = new Client(app);
    const r = await bare.getKey('/api/api-keys', key);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('SCOPE_FORBIDDEN');
  });
});
