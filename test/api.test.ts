// 灵镜 API 单元测试 —— 入参校验(登录后,creator 角色)。

import { describe, it, expect, beforeAll } from 'vitest';

process.env.DB_FILE = ':memory:';

const { createApp } = await import('../src/server.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { grant } = await import('../src/credits/index.js');
const { Client } = await import('./helpers.js');

const app = createApp();
const client = new Client(app);
let tenantId: string;

beforeAll(async () => {
  const t = createTenant('测试台');
  tenantId = t.id;
  createUser(tenantId, 'creator1', 'pw123456', 'creator');
  grant(tenantId, 10000); // 有积分才能发起生成(Slice3 计费门)
  const r = await client.login('creator1', 'pw123456');
  expect(r.status).toBe(200);
});

describe('POST /api/jobs 校验(已登录 creator)', () => {
  it('缺 avatarRef → 400', async () => {
    const r = await client.post('/api/jobs', { voiceRef: 'v', script: '文案' });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('形象');
  });

  it('缺 script → 400', async () => {
    const r = await client.post('/api/jobs', { avatarRef: 'a', voiceRef: 'v' });
    expect(r.status).toBe(400);
  });

  it('文案超 2000 字 → 400', async () => {
    const r = await client.post('/api/jobs', { avatarRef: 'a', voiceRef: 'v', script: '字'.repeat(2001) });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('2000');
  });

  it('合法入参 → 202 + jobId', async () => {
    const r = await client.post('/api/jobs', { avatarRef: 'preset-1', voiceRef: 'longjing', script: '正常文案' });
    expect(r.status).toBe(202);
    expect(r.body.id).toBeTruthy();
    expect(r.body.status).toBe('queued');
  });
});
