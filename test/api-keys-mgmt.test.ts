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

describe('DELETE /api/api-keys/:id(吊销)', () => {
  it('成员吊自己的 → 200,key 立即失效', async () => {
    const k = await creator.post('/api/api-keys', { name: 'to-del' });
    const plain = k.body.key;
    expect(resolveApiKey(`Bearer ${plain}`)).not.toBeNull();
    const r = await creator.del(`/api/api-keys/${k.body.id}`);
    expect(r.status).toBe(200);
    expect(resolveApiKey(`Bearer ${plain}`)).toBeNull();
  });

  it('成员吊别人的 → 404(够不到)', async () => {
    const adminKey = await admin.post('/api/api-keys', { name: 'admin-key-2' });
    const r = await creator.del(`/api/api-keys/${adminKey.body.id}`);
    expect(r.status).toBe(404);
    expect(resolveApiKey(`Bearer ${adminKey.body.key}`)).not.toBeNull(); // 仍有效
  });

  it('admin 吊任意成员的 → 200', async () => {
    const creatorKey = await creator.post('/api/api-keys', { name: 'admin-revokes-this' });
    const r = await admin.del(`/api/api-keys/${creatorKey.body.id}`);
    expect(r.status).toBe(200);
    expect(resolveApiKey(`Bearer ${creatorKey.body.key}`)).toBeNull();
  });

  it('吊销写审计', async () => {
    const k = await creator.post('/api/api-keys', { name: 'audit-revoke' });
    await creator.del(`/api/api-keys/${k.body.id}`);
    const rows = listAudit(tId, 50, creatorId, false) as { action: string }[];
    expect(rows.some((a) => a.action === 'revoke_api_key')).toBe(true);
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
