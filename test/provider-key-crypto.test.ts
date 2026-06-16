// 灵镜 — Provider Key 加密 PR-1:E2 六条失败路径全覆盖。
// 决策来源:ceo-plans/2026-06-16-model-access-platform(eng review 8.5 + 外部声音 6→吸收)。
// 覆盖:① 加解密 round-trip ② admin 只见 last4 ③ MASTER_KEY 缺失回落 .env
//       ④ 解密失败 FAIL(PROVIDER_KEY_DECRYPT_FAILED)⑤ AAD 防行间搬移 ⑥ 缓存按 updated_at 失效。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

process.env.DB_FILE = ':memory:';
process.env.MASTER_KEY = 'test-master-key-for-vitest-only-32b';
const { db } = await import('../src/db/index.js');
const { encryptKey, decryptKey, lastFour, masterKey } = await import('../src/gateway/key-crypto.js');
const { getProviderKey, setProviderKey, clearProviderKeyCache, ProviderKeyError } = await import('../src/gateway/provider-keys.js');

function resetProvider(id = 'bailian', name = '阿里百炼') {
  db.prepare('DELETE FROM provider WHERE id=?').run(id);
  db.prepare(
    `INSERT INTO provider (id,name,adapter_key,base_url,key_version,enabled,updated_at) VALUES (?,?,?,?,1,1,?)`,
  ).run(id, name, id, 'https://example.com', Date.now());
  clearProviderKeyCache();
}

describe('key-crypto 基元(AES-256-GCM)', () => {
  it('① round-trip:加密后解密还原明文', () => {
    const b = encryptKey('sk-secret-12345', 'bailian');
    expect(decryptKey(b, 'bailian')).toBe('sk-secret-12345');
  });
  it('② last4 脱敏:只露尾 4 位', () => {
    expect(lastFour('sk-abcdefgh1234')).toBe('***1234');
  });
  it('⑤ AAD 防行间搬移:换 AAD 解密失败', () => {
    const b = encryptKey('sk-secret-12345', 'bailian');
    expect(() => decryptKey(b, 'volc-ark')).toThrow(); // GCM 认证失败(AAD 不符)
  });
  it('IV 每次随机:同明文两次密文不同', () => {
    const a = encryptKey('sk-x', 'bailian'), c = encryptKey('sk-x', 'bailian');
    expect(a.cipher.equals(c.cipher)).toBe(false);
  });
});

describe('getProviderKey / setProviderKey 全路径', () => {
  beforeEach(() => { resetProvider(); process.env.MASTER_KEY = 'test-master-key-for-vitest-only-32b'; });
  afterEach(() => { process.env.MASTER_KEY = 'test-master-key-for-vitest-only-32b'; });

  it('① 写 key→取 key round-trip(走加密表)', () => {
    setProviderKey('bailian', 'sk-live-001');
    expect(getProviderKey('bailian')).toBe('sk-live-001');
  });

  it('② 写 key 后库里只存 last4 + 密文(无明文列)', () => {
    setProviderKey('bailian', 'sk-live-abcd');
    const row = db.prepare('SELECT api_key_last4, api_key_cipher FROM provider WHERE id=?').get('bailian') as { api_key_last4: string; api_key_cipher: Buffer };
    expect(row.api_key_last4).toBe('***abcd');
    expect(row.api_key_cipher.toString('utf8')).not.toContain('sk-live-abcd'); // 密文不含明文
  });

  it('③ 无 cipher + 有 .env → 回落 .env', () => {
    process.env.DASHSCOPE_API_KEY = 'sk-from-env';
    // 不调 setProviderKey,provider 行无 cipher → 回落
    expect(getProviderKey('bailian')).toBe('sk-from-env');
    delete process.env.DASHSCOPE_API_KEY;
  });

  it('③b MASTER_KEY 缺失(即便有 cipher)→ 回落 .env', () => {
    setProviderKey('bailian', 'sk-encrypted'); // 先用主密钥加密入库
    process.env.DASHSCOPE_API_KEY = 'sk-env-fallback';
    delete process.env.MASTER_KEY; // 主密钥没了
    clearProviderKeyCache();
    expect(getProviderKey('bailian')).toBe('sk-env-fallback'); // 解不了密文 → 回落 .env
    delete process.env.DASHSCOPE_API_KEY;
  });

  it('④ 有 cipher 但解密失败(MASTER_KEY 变了、无 .env 回落)→ 抛 PROVIDER_KEY_DECRYPT_FAILED', () => {
    setProviderKey('bailian', 'sk-encrypted');
    process.env.MASTER_KEY = 'a-totally-different-master-key-now'; // 换了主密钥没轮转
    delete process.env.DASHSCOPE_API_KEY; // 无 .env 回落
    clearProviderKeyCache();
    try { getProviderKey('bailian'); expect.fail('应抛错'); }
    catch (e) { expect((e as InstanceType<typeof ProviderKeyError>).code).toBe('PROVIDER_KEY_DECRYPT_FAILED'); }
  });

  it('⑥ 缓存按 updated_at 失效:改 key 后取到新值', () => {
    setProviderKey('bailian', 'sk-v1');
    expect(getProviderKey('bailian')).toBe('sk-v1'); // 进缓存
    setProviderKey('bailian', 'sk-v2'); // bump updated_at + 清缓存
    expect(getProviderKey('bailian')).toBe('sk-v2');
  });

  it('无 cipher 无 .env → PROVIDER_KEY_MISSING', () => {
    delete process.env.DASHSCOPE_API_KEY;
    try { getProviderKey('bailian'); expect.fail('应抛错'); }
    catch (e) { expect((e as InstanceType<typeof ProviderKeyError>).code).toBe('PROVIDER_KEY_MISSING'); }
  });

  it('setProviderKey 无 MASTER_KEY → 拒绝(不允许明文落库)', () => {
    delete process.env.MASTER_KEY;
    expect(() => setProviderKey('bailian', 'sk-x')).toThrow();
  });
});
