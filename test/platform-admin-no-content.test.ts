// 灵镜 — 平台超管不得触达租户生成内容(2026-07-25 用户隔离决策的回归锁)。
//
// 背景:超管控制台按设计只看运营元数据(租户 / 模块 / 模型 / 积分 / 状态 / 耗时 / 错误),
//   **不含**提示词(input_json 的 prompt/script/text/lyrics)与产物 key(output_url)。
//   这是当前实现的行为,本文件把它锁死 —— 防止以后有人为了排障「顺手把 input_json 带上」,
//   一行改动就把全平台用户的提示词泄漏给运营。
//
// 做法:给 job 塞进可识别的哨兵字符串(提示词 + 产物 key),遍历超管的任务相关端点,
//   断言响应体全文不含任何哨兵。用全文扫描而非逐字段断言 —— 新增字段也会被自动覆盖。

import { describe, it, expect, beforeAll } from 'vitest';

process.env.DB_FILE = ':memory:';
process.env.SUPERADMIN_USER = 'padmin';
process.env.SUPERADMIN_PASS = 'superpw123';

const { createApp } = await import('../src/server.js');
const { createTenant } = await import('../src/auth/index.js');
const { bootstrapSuperadmin } = await import('../src/auth/platform.js');
const { db } = await import('../src/db/index.js');
const { Client } = await import('./helpers.js');

const app = createApp();
let tid = '';

// 哨兵:每个都是现实中会出现在 input_json / output_url 里的敏感内容。
const SECRET_PROMPT = 'SENTINEL_PROMPT_离婚协议书配图';
const SECRET_SCRIPT = 'SENTINEL_SCRIPT_内部财报播报稿';
const SECRET_TEXT = 'SENTINEL_TEXT_待录制的私密文本';
const SECRET_LYRICS = 'SENTINEL_LYRICS_未发布的歌词';
const SECRET_OUTPUT = 'SENTINEL_OUTPUT_outputs/private/a1b2c3.png';
const SENTINELS = [SECRET_PROMPT, SECRET_SCRIPT, SECRET_TEXT, SECRET_LYRICS, SECRET_OUTPUT];

let seq = 0;
function seedJob(type: string, input: Record<string, unknown>): string {
  const id = `secret-job-${++seq}`;
  const t = Date.now() - 60_000;
  db.prepare(
    `INSERT INTO job (id, tenant_id, type, status, progress, input_json, output_url, output_kind,
                      created_by, attempts, created_at, updated_at, started_at)
     VALUES (?,?,?,'done',100,?,?,?,?,1,?,?,?)`,
  ).run(id, tid, type, JSON.stringify(input), JSON.stringify([SECRET_OUTPUT]),
        type === 'ai_image' ? 'image' : 'video', 'some-user', t, t + 30_000, t + 1000);
  return id;
}

async function padminLogin(): Promise<InstanceType<typeof Client>> {
  const c = new Client(app);
  const r = await c.login('padmin', 'superpw123', '/admin/login');
  expect(r.status).toBe(200);
  return c;
}

beforeAll(async () => {
  await bootstrapSuperadmin();
  tid = createTenant('内容敏感租户').id;
  db.prepare(`DELETE FROM job`).run();
  // 覆盖各工具的主文案字段口径(与 summarizeJobInput 对齐):prompt / script / text / lyrics。
  seedJob('ai_image', { prompt: SECRET_PROMPT, model: 'nano-banana', count: 2 });
  seedJob('video', { script: SECRET_SCRIPT, avatarRef: 'preset-1', voiceRef: 'Cherry' });
  seedJob('tts', { text: SECRET_TEXT, voiceRef: 'Cherry' });
  seedJob('ai_music', { prompt: 'x', lyrics: SECRET_LYRICS });
});

describe('平台超管端点不下发租户生成内容', () => {
  const ENDPOINTS = [
    '/admin/api/consumption?page=1&pageSize=50',
    '/admin/api/metrics/recent-jobs?limit=200',
    '/admin/api/metrics/by-tenant',
    '/admin/api/metrics/concurrency?range=24h',
    '/admin/api/metrics/overview',
    '/admin/api/metrics/ops',
  ];

  it('遍历超管任务相关端点:响应全文不含提示词 / 文案 / 产物 key', async () => {
    const c = await padminLogin();
    for (const path of ENDPOINTS) {
      const r = await c.get(path);
      // 必须真的访问到 —— 404 会让「响应不含哨兵」变成假绿(空响应当然不含)。
      // 端点改名时这里会红,提示把新路径补进 ENDPOINTS,而不是静默丢失覆盖。
      expect(r.status, `${path} 应可访问(404 说明路径过时,请更新 ENDPOINTS)`).toBeLessThan(400);
      const body = JSON.stringify(r.body);
      for (const s of SENTINELS) {
        expect(body.includes(s), `${path} 泄漏了内容哨兵:${s}`).toBe(false);
      }
    }
  });

  it('消耗流水仍给得出运营要的元数据(证明上面的「不含」不是因为端点返回空)', async () => {
    const c = await padminLogin();
    const r = await c.get('/admin/api/consumption?page=1&pageSize=50');
    expect(r.status).toBe(200);
    expect(r.body.rows.length).toBeGreaterThanOrEqual(4);
    const img = (r.body.rows as Record<string, unknown>[]).find((x) => x.module === 'ai_image');
    expect(img).toBeTruthy();
    expect(img!.model).toBe('nano-banana'); // 模型名是元数据,该给
    expect(img!.quantity).toBe(2); // 张数是计费原料,该给
    expect(img!.tenantName).toBe('内容敏感租户');
  });

  it('未登录超管 → 401(哨兵测试本身不能因为鉴权失败而假绿)', async () => {
    const anon = new Client(app);
    const r = await anon.get('/admin/api/consumption');
    expect(r.status).toBe(401);
  });
});
