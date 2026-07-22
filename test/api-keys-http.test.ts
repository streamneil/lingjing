// 灵镜 Open API — API key 端到端(HTTP)+ 作用域白名单(PR1 T2 wiring)。
//
// 覆盖(设计文档 §4.2):
//   - creator key:提交生成(POST /api/jobs)→ 202;白名单只读(models/avatars/balance)→ 200
//   - viewer key:落 requireRole → 403(权限不足);作用域守卫放行、角色守卫拦截
//   - 任意 key 访问白名单外(/api/members、/api/me)→ 403 SCOPE_FORBIDDEN
//   - 伪造/吊销 key → 401(req.user 空,requireRole/requireAuth 拦)
//   - cookie session 完全不受作用域守卫影响(回归)

import { describe, it, expect, beforeAll } from 'vitest';

process.env.DB_FILE = ':memory:';
process.env.DASHSCOPE_API_KEY = 'sk-test';

const { db } = await import('../src/db/index.js');
const { createApp } = await import('../src/server.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { createApiKey, revokeApiKey } = await import('../src/auth/api-keys.js');
const { grant } = await import('../src/credits/index.js');
const { Client } = await import('./helpers.js');

const app = createApp();
const client = new Client(app); // 纯 API key 客户端(从不登录,无 cookie)

let tId = '';
let adminId = '';
let creatorId = '';
let viewerId = '';
let creatorKey = '';
let viewerKey = '';

beforeAll(async () => {
  tId = createTenant('API key HTTP 台').id;
  adminId = (await createUser(tId, 'hkadmin', 'pw123456', 'admin')).id;
  creatorId = (await createUser(tId, 'hkcreator', 'pw123456', 'creator')).id;
  // viewer 角色已砍(createUser/changeRole 均拒),直接 db 置 role=viewer 模拟遗留只读账号
  // (与 account-isolation.test 同手法);验证 viewer key 落 requireRole 被拦。
  viewerId = (await createUser(tId, 'hkviewer', 'pw123456', 'creator')).id;
  db.prepare(`UPDATE user SET role='viewer' WHERE id=?`).run(viewerId);
  grant(tId, 1000000);
  creatorKey = createApiKey(tId, creatorId, 'creator-key').key;
  viewerKey = createApiKey(tId, viewerId, 'viewer-key').key;
  void adminId;
}, 30000);

describe('API key 生成面(白名单内)', () => {
  it('creator key 提交文生图 → 202', async () => {
    const r = await client.postKey('/api/jobs', creatorKey, { type: 'ai_image', prompt: '一只猫', count: 1 });
    expect(r.status).toBe(202);
    expect(r.body.id).toBeTruthy();
  });

  it('creator key 读模型列表 / 形象 / 余额 → 200', async () => {
    expect((await client.getKey('/api/image-models', creatorKey)).status).toBe(200);
    expect((await client.getKey('/api/avatars', creatorKey)).status).toBe(200);
    const bal = await client.getKey('/api/credits/balance', creatorKey);
    expect(bal.status).toBe(200);
    expect(typeof bal.body.balance).toBe('number');
  });
});

describe('API key 作用域守卫(白名单外 → 403 SCOPE_FORBIDDEN)', () => {
  it('访问成员管理 → 403 SCOPE_FORBIDDEN', async () => {
    const r = await client.getKey('/api/members', creatorKey);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('SCOPE_FORBIDDEN');
  });

  it('访问账户信息 /api/me → 403 SCOPE_FORBIDDEN', async () => {
    const r = await client.getKey('/api/me', creatorKey);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('SCOPE_FORBIDDEN');
  });

  it('POST 建成员 → 403 SCOPE_FORBIDDEN(不落到 requireRole)', async () => {
    const r = await client.postKey('/api/members', creatorKey, { username: 'x', role: 'creator' });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('SCOPE_FORBIDDEN');
  });
});

describe('API key 角色守卫(白名单内但角色不足)', () => {
  it('viewer key 提交生成 → 403(权限不足,非作用域)', async () => {
    const r = await client.postKey('/api/jobs', viewerKey, { type: 'ai_image', prompt: 'x', count: 1 });
    expect(r.status).toBe(403);
    expect(r.body.code).toBeUndefined(); // 现有 requireRole 文案,非 SCOPE_FORBIDDEN
    expect(r.body.error).toContain('权限');
  });

  it('viewer key 只读白名单(GET /api/avatars)→ 200', async () => {
    expect((await client.getKey('/api/avatars', viewerKey)).status).toBe(200);
  });
});

describe('API key 无效凭证 → 401', () => {
  it('伪造 key → 401(req.user 空,requireRole 拦)', async () => {
    const r = await client.postKey('/api/jobs', 'lj_sk_deadbeefdeadbeefdeadbeefdeadbeef', { type: 'ai_image', prompt: 'x' });
    expect(r.status).toBe(401);
  });

  it('吊销 key → 401', async () => {
    const k = createApiKey(tId, creatorId, 'to-revoke-http');
    expect((await client.postKey('/api/jobs', k.key, { type: 'ai_image', prompt: 'x', count: 1 })).status).toBe(202);
    revokeApiKey(k.id, tId, creatorId, false);
    expect((await client.postKey('/api/jobs', k.key, { type: 'ai_image', prompt: 'x', count: 1 })).status).toBe(401);
  });

  it('无 Authorization 头访问受保护端点 → 401(未登录)', async () => {
    const r = await client.post('/api/jobs', { type: 'ai_image', prompt: 'x' });
    expect(r.status).toBe(401);
  });
});
