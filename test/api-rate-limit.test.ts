// 灵镜 Open API — 限速中间件端到端(PR1 T4,D9 读写分级)。
//
// 小上限经 env 覆盖(写 3/读 5),免打真实 60/300 次。覆盖:
//   - 写(POST /jobs):放行到 3,第 4 次 → 429 RATE_LIMITED
//   - 读(GET models):独立计数,放行到 5,第 6 次 → 429
//   - 不同 key 独立;cookie session 不受限(回归)

process.env.DB_FILE = ':memory:';
process.env.DASHSCOPE_API_KEY = 'sk-test';
process.env.API_RATE_WRITE_PER_MIN = '3';
process.env.API_RATE_READ_PER_MIN = '5';

import { describe, it, expect, beforeAll } from 'vitest';

const { createApp } = await import('../src/server.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { createApiKey } = await import('../src/auth/api-keys.js');
const { grant } = await import('../src/credits/index.js');
const { Client } = await import('./helpers.js');

const app = createApp();
const client = new Client(app);

let tId = '';
let creatorId = '';

beforeAll(async () => {
  tId = createTenant('限速台').id;
  creatorId = (await createUser(tId, 'rlcreator', 'pw123456', 'creator')).id;
  grant(tId, 10_000_000);
}, 30000);

describe('写口径限速(POST /jobs 3/min)', () => {
  it('放行到 3,第 4 次 → 429 RATE_LIMITED', async () => {
    const key = createApiKey(tId, creatorId, 'write-rl').key;
    const body = { type: 'ai_image', prompt: 'x', count: 1 };
    for (let i = 0; i < 3; i++) {
      const r = await client.postKey('/api/jobs', key, body);
      expect(r.status).toBe(202);
    }
    const over = await client.postKey('/api/jobs', key, body);
    expect(over.status).toBe(429);
    expect(over.body.code).toBe('RATE_LIMITED');
  });
});

describe('读口径限速(GET 5/min,与写独立)', () => {
  it('放行到 5,第 6 次 → 429', async () => {
    const key = createApiKey(tId, creatorId, 'read-rl').key;
    for (let i = 0; i < 5; i++) {
      expect((await client.getKey('/api/image-models', key)).status).toBe(200);
    }
    const over = await client.getKey('/api/image-models', key);
    expect(over.status).toBe(429);
    expect(over.body.code).toBe('RATE_LIMITED');
  });

  it('同 key 的读写各自独立计数', async () => {
    const key = createApiKey(tId, creatorId, 'split-rl').key;
    // 先耗尽写(3)
    const body = { type: 'ai_image', prompt: 'y', count: 1 };
    for (let i = 0; i < 3; i++) await client.postKey('/api/jobs', key, body);
    expect((await client.postKey('/api/jobs', key, body)).status).toBe(429); // 写满
    // 读仍可用(独立计数器)
    expect((await client.getKey('/api/image-models', key)).status).toBe(200);
  });
});

describe('隔离', () => {
  it('不同 key 独立计数', async () => {
    const k1 = createApiKey(tId, creatorId, 'iso-1').key;
    const k2 = createApiKey(tId, creatorId, 'iso-2').key;
    const body = { type: 'ai_image', prompt: 'z', count: 1 };
    for (let i = 0; i < 3; i++) await client.postKey('/api/jobs', k1, body);
    expect((await client.postKey('/api/jobs', k1, body)).status).toBe(429); // k1 满
    expect((await client.postKey('/api/jobs', k2, body)).status).toBe(202); // k2 不受影响
  });

  it('cookie session 不受 API 限速影响', async () => {
    const cookieClient = new Client(app);
    const lr = await cookieClient.login('rlcreator', 'pw123456');
    expect(lr.status).toBe(200);
    // 远超写上限 3 的 cookie 提交仍全部放行(viaApiKey=false)
    for (let i = 0; i < 6; i++) {
      const r = await cookieClient.post('/api/jobs', { type: 'ai_image', prompt: 'c', count: 1 });
      expect(r.status).toBe(202);
    }
  });
});
