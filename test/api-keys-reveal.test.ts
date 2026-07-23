// 灵镜 Open API — 密钥可随时复制(明文加密存储 + reveal 端点)。
//
// 产品决策:让用户随时复制完整密钥(不再"只显示一次")。实现:创建时把明文用
// AES-256-GCM 加密存库(AAD=key id,同第三方厂商 key 那套),reveal 时解密回显。
// 覆盖:reveal 自己的 → 明文匹配;别人的 → 404;写审计;旧库无密文 → recoverable:false;
//       库里存的是密文不是明文(安全)。

import { describe, it, expect, beforeAll } from 'vitest';

process.env.DB_FILE = ':memory:';
process.env.MASTER_KEY = 'test-master-key-for-apikey-reveal';

const { db } = await import('../src/db/index.js');
const { createApp } = await import('../src/server.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { createApiKey, revealApiKey } = await import('../src/auth/api-keys.js');
const { listAudit } = await import('../src/audit/index.js');
const { Client } = await import('./helpers.js');

const app = createApp();

let tId = '';
let creatorId = '';
let otherId = '';
const creator = new Client(app);

beforeAll(async () => {
  tId = createTenant('reveal 台').id;
  creatorId = (await createUser(tId, 'rvcreator', 'pw123456', 'creator')).id;
  otherId = (await createUser(tId, 'rvother', 'pw123456', 'creator')).id;
  expect((await creator.login('rvcreator', 'pw123456')).status).toBe(200);
}, 30000);

describe('createApiKey 加密存储', () => {
  it('库里存密文不是明文(明文搜不到)', () => {
    const { id, key } = createApiKey(tId, creatorId, 'enc-store');
    const row = db.prepare(`SELECT * FROM api_key WHERE id=?`).get(id);
    const dump = JSON.stringify(row); // BLOB 序列化为字节数组,也不含明文子串
    expect(dump).not.toContain(key);
    // 但 key_cipher 非空(可回复)
    const c = db.prepare(`SELECT key_cipher FROM api_key WHERE id=?`).get(id) as { key_cipher: Buffer | null };
    expect(c.key_cipher).toBeTruthy();
  });
});

describe('revealApiKey(函数)', () => {
  it('自己的 key → 解密回明文,与创建时一致', () => {
    const { id, key } = createApiKey(tId, creatorId, 'reveal-me');
    const r = revealApiKey(id, tId, creatorId);
    expect(r).toEqual({ key });
  });

  it('别人的 key → null(仅限本人)', () => {
    const { id } = createApiKey(tId, otherId, 'others');
    expect(revealApiKey(id, tId, creatorId)).toBeNull(); // creator 够不到 other 的
  });

  it('无密文的旧 key → recoverable:false', () => {
    // 直接插一条没有 cipher 的行(模拟旧库/未配 MASTER_KEY 时创建的)
    const id = 'legacy-key-id';
    db.prepare(`INSERT INTO api_key (id,tenant_id,user_id,name,key_hash,key_prefix,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(id, tId, creatorId, 'legacy', 'deadbeef'.repeat(8), 'lj_sk_legacy', Date.now());
    expect(revealApiKey(id, tId, creatorId)).toEqual({ recoverable: false });
  });
});

describe('GET /api/api-keys/:id/reveal', () => {
  it('reveal 自己的 → 200 {key} 明文', async () => {
    const { id, key } = createApiKey(tId, creatorId, 'http-reveal');
    const r = await creator.get(`/api/api-keys/${id}/reveal`);
    expect(r.status).toBe(200);
    expect(r.body.key).toBe(key);
  });

  it('reveal 别人的 → 404', async () => {
    const { id } = createApiKey(tId, otherId, 'http-other');
    const r = await creator.get(`/api/api-keys/${id}/reveal`);
    expect(r.status).toBe(404);
  });

  it('reveal 写审计', async () => {
    const { id } = createApiKey(tId, creatorId, 'http-audit');
    await creator.get(`/api/api-keys/${id}/reveal`);
    const rows = listAudit(tId, 80, creatorId, false) as { action: string }[];
    expect(rows.some((a) => a.action === 'reveal_api_key')).toBe(true);
  });
});
