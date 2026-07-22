// 灵镜 Open API — API key 体系(PR1 T2:数据模型 + 认证)。
//
// 覆盖(设计文档 §4.1/4.2 + eng-review D13#7):
//   - createApiKey:返回明文一次;库里只存 SHA-256 哈希 + 前缀;审计可查
//   - resolveApiKey:有效 key → 与 session 登录完全一致的 AuthedUser(key == 成员本人)
//   - 吊销/伪造/未知 key → null;key 主人被停用 → null(每请求查最新状态,同 resolveSession)
//   - listApiKeys:成员看自己的;admin 看全租户;revokeApiKey 幂等
//   - key 格式 lj_sk_…;明文不落库(库里搜不到明文)

import { describe, it, expect, beforeAll } from 'vitest';

process.env.DB_FILE = ':memory:';

const { db } = await import('../src/db/index.js');
const { createTenant, createUser, resolveSession, setUserStatus } = await import('../src/auth/index.js');
const {
  createApiKey, resolveApiKey, listApiKeys, revokeApiKey,
} = await import('../src/auth/api-keys.js');

let tId = '';
let aliceId = '';
let bobId = '';
let adminId = '';

beforeAll(async () => {
  tId = createTenant('API key 测试台').id;
  adminId = (await createUser(tId, 'akadmin', 'pw123456', 'admin')).id;
  aliceId = (await createUser(tId, 'akalice', 'pw123456', 'creator')).id;
  bobId = (await createUser(tId, 'akbob', 'pw123456', 'creator')).id;
});

describe('createApiKey', () => {
  it('返回明文一次 + 前缀;库里只存哈希(明文搜不到)', () => {
    const { id, key, prefix } = createApiKey(tId, aliceId, '我的 Claude Code');
    expect(id).toBeTruthy();
    expect(key).toMatch(/^lj_sk_[0-9a-f]{32,}$/);
    expect(prefix).toBe(key.slice(0, 12));
    // 明文绝不落库
    const rows = db.prepare(`SELECT key_hash, key_prefix, name FROM api_key WHERE id=?`).get(id) as {
      key_hash: string; key_prefix: string; name: string;
    };
    expect(rows.key_hash).not.toContain(key);
    expect(rows.key_hash.length).toBe(64); // sha256 hex
    expect(rows.key_prefix).toBe(prefix);
    expect(rows.name).toBe('我的 Claude Code');
    // 全表任何列都不含明文
    const dump = JSON.stringify(db.prepare(`SELECT * FROM api_key WHERE id=?`).get(id));
    expect(dump).not.toContain(key);
  });
});

describe('resolveApiKey', () => {
  it('有效 key → AuthedUser(key == 成员本人)', () => {
    const { key } = createApiKey(tId, aliceId, 'k1');
    const viaKey = resolveApiKey(`Bearer ${key}`);
    expect(viaKey).not.toBeNull();
    expect(viaKey!.id).toBe(aliceId);
    expect(viaKey!.role).toBe('creator');
  });

  it('身份对象与 resolveSession 一致(逐字段)', async () => {
    const auth = await import('../src/auth/index.js');
    const sessTok = await auth.login('akbob', 'pw123456');
    const viaSession = resolveSession(sessTok)!;
    const { key } = createApiKey(tId, bobId, 'k-parity');
    const viaKey = resolveApiKey(`Bearer ${key}`)!;
    expect(viaKey).toEqual(viaSession);
  });

  it('吊销的 key → null', () => {
    const { id, key } = createApiKey(tId, aliceId, 'to-revoke');
    expect(resolveApiKey(`Bearer ${key}`)).not.toBeNull();
    revokeApiKey(id, tId, aliceId, false);
    expect(resolveApiKey(`Bearer ${key}`)).toBeNull();
  });

  it('伪造/未知 key → null', () => {
    expect(resolveApiKey('Bearer lj_sk_deadbeefdeadbeefdeadbeefdeadbeef')).toBeNull();
    expect(resolveApiKey('Bearer garbage')).toBeNull();
    expect(resolveApiKey(undefined)).toBeNull();
    expect(resolveApiKey('')).toBeNull();
  });

  it('非 Bearer / 非 lj_sk_ 前缀 → null', () => {
    const { key } = createApiKey(tId, aliceId, 'shape');
    expect(resolveApiKey(key)).toBeNull(); // 缺 Bearer
    expect(resolveApiKey(`Basic ${key}`)).toBeNull();
  });

  it('key 主人被停用 → null(每请求查最新状态)', () => {
    const disabledUserKey = createApiKey(tId, bobId, 'owner-will-disable');
    expect(resolveApiKey(`Bearer ${disabledUserKey.key}`)).not.toBeNull();
    setUserStatus(tId, bobId, 'disabled', adminId);
    expect(resolveApiKey(`Bearer ${disabledUserKey.key}`)).toBeNull();
    setUserStatus(tId, bobId, 'active', adminId); // 复原,免污染其他用例
  });
});

describe('listApiKeys / revokeApiKey', () => {
  it('成员只看自己的;admin 看全租户', () => {
    const other = createTenant('别的租户').id;
    const own = createApiKey(tId, aliceId, 'alice-owns');
    const adminOwn = createApiKey(tId, adminId, 'admin-owns');

    const aliceList = listApiKeys(tId, aliceId, false).map((k) => k.id);
    expect(aliceList).toContain(own.id);
    expect(aliceList).not.toContain(adminOwn.id); // 看不到 admin 的

    const adminList = listApiKeys(tId, adminId, true).map((k) => k.id);
    expect(adminList).toContain(own.id); // admin 看得到 alice 的
    expect(adminList).toContain(adminOwn.id);

    // 列表不含明文/哈希(只前缀 + 元数据)
    const row = listApiKeys(tId, aliceId, false).find((k) => k.id === own.id)!;
    expect(row.key_prefix).toMatch(/^lj_sk_/);
    expect((row as unknown as Record<string, unknown>).key_hash).toBeUndefined();
    void other;
  });

  it('admin 可吊销任意成员的 key;成员不能吊销别人的', () => {
    const aliceKey = createApiKey(tId, aliceId, 'alice-k');
    // bob 吊销 alice 的 → 失败
    expect(revokeApiKey(aliceKey.id, tId, bobId, false)).toBe(false);
    expect(resolveApiKey(`Bearer ${aliceKey.key}`)).not.toBeNull();
    // admin 吊销 alice 的 → 成功
    expect(revokeApiKey(aliceKey.id, tId, adminId, true)).toBe(true);
    expect(resolveApiKey(`Bearer ${aliceKey.key}`)).toBeNull();
    // 重复吊销幂等(已吊销再吊 → false,无副作用)
    expect(revokeApiKey(aliceKey.id, tId, adminId, true)).toBe(false);
  });

  it('跨租户吊销拒绝(admin 只管本租户)', () => {
    const other = createTenant('第三方租户').id;
    const otherAdmin = 'x'; // 无需真实用户;revoke 按 (id, tenantId) 定位
    const k = createApiKey(tId, aliceId, 'cross-tenant-guard');
    expect(revokeApiKey(k.id, other, otherAdmin, true)).toBe(false); // 别的租户 admin 够不到
    expect(resolveApiKey(`Bearer ${k.key}`)).not.toBeNull();
  });
});
