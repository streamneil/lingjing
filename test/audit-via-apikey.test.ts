// 灵镜 Open API — 审计标记 via_api_key(PR1 T6c,设计文档 §4.7 + 外部声音 #7)。
//
// 区分「本人网页操作」与「客户 Agent 经 API key 操作」:经 key 提交的 create_job
// 审计行带 via_api_key=<keyId>;cookie 提交为 null。事后可追溯是谁的 agent 动的。

import { describe, it, expect, beforeAll } from 'vitest';

process.env.DB_FILE = ':memory:';
process.env.DASHSCOPE_API_KEY = 'sk-test';

const { db } = await import('../src/db/index.js');
const { createApp } = await import('../src/server.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { createApiKey } = await import('../src/auth/api-keys.js');
const { grant } = await import('../src/credits/index.js');
const { Client } = await import('./helpers.js');

const app = createApp();

let tId = '';
let creatorId = '';
let keyId = '';
let keyPlain = '';

beforeAll(async () => {
  tId = createTenant('审计标记台').id;
  creatorId = (await createUser(tId, 'avcreator', 'pw123456', 'creator')).id;
  grant(tId, 1_000_000);
  const k = createApiKey(tId, creatorId, 'audit-mark-key');
  keyId = k.id;
  keyPlain = k.key;
}, 30000);

function lastCreateJobAudit(): { target: string; via_api_key: string | null } | undefined {
  return db
    .prepare(`SELECT target, via_api_key FROM audit_log WHERE tenant_id=? AND action='create_job' ORDER BY created_at DESC LIMIT 1`)
    .get(tId) as { target: string; via_api_key: string | null } | undefined;
}

describe('create_job 审计 via_api_key 标记', () => {
  it('经 API key 提交 → 审计行 via_api_key = keyId', async () => {
    const client = new Client(app);
    const r = await client.postKey('/api/jobs', keyPlain, { type: 'ai_image', prompt: 'k', count: 1 });
    expect(r.status).toBe(202);
    const row = lastCreateJobAudit()!;
    expect(row.target).toBe(r.body.id);
    expect(row.via_api_key).toBe(keyId);
  });

  it('经 cookie 提交 → 审计行 via_api_key 为 null(本人操作)', async () => {
    const client = new Client(app);
    expect((await client.login('avcreator', 'pw123456')).status).toBe(200);
    const r = await client.post('/api/jobs', { type: 'ai_image', prompt: 'c', count: 1 });
    expect(r.status).toBe(202);
    const row = lastCreateJobAudit()!;
    expect(row.target).toBe(r.body.id);
    expect(row.via_api_key).toBeNull();
  });
});
