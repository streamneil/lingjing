// 灵镜 — Provider API Key 取用/写入(解密 + 缓存 + .env 回落)。
//
// 决策来源:/plan-ceo-review + /plan-eng-review 2026-06-16-model-access-platform(PR-1)。
// 读价路径不变,这里只管「网关调用时取哪个 key」。加密基元在 key-crypto.ts(叶子);
// 本文件接 db(读 provider 行)+ config(.env 回落),由各 gateway 调用 —— 无环(db 不 import 本文件)。
//
// 取 key 优先级(eng 外部声音 P1.3 锁定):
//   ① provider.api_key_cipher 有 + MASTER_KEY 在 → 解密(进程内缓存,按 updated_at 失效)
//   ② 否则(无 cipher 或无 MASTER_KEY)→ 回落 .env(过渡期兼容)
//   ③ 都没有 → 抛错
// 解密失败(密文坏/AAD 不符/换了 MASTER_KEY 没轮转)→ 抛 PROVIDER_KEY_DECRYPT_FAILED,
//   调用方(worker)据此 FAIL 该 job,绝不静默、不冻 worker。

import { db, type ProviderRow } from '../db/index.js';
import { decryptKey, encryptKey, lastFour, masterKey } from './key-crypto.js';

export class ProviderKeyError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ProviderKeyError';
  }
}

// provider.id → .env 变量名(回落用)。bailian 历史 key 在 DASHSCOPE_API_KEY。
const ENV_FALLBACK: Record<string, string> = {
  bailian: 'DASHSCOPE_API_KEY',
};

// 解密缓存:provider.id → { key, updatedAt }。updated_at 变(admin 改 key)→ 失效重解。
const _cache = new Map<string, { key: string; updatedAt: number }>();

let _rowStmt: import('better-sqlite3').Statement | null = null;
function providerRow(id: string): ProviderRow | undefined {
  _rowStmt ??= db.prepare('SELECT * FROM provider WHERE id = ?');
  return _rowStmt.get(id) as ProviderRow | undefined;
}

/**
 * 取某 provider 的明文 API key(网关调用时用)。优先解密库内密文,回落 .env。
 * @throws ProviderKeyError('PROVIDER_KEY_DECRYPT_FAILED') 密文存在但解不开(坏/换主密钥未轮转)
 * @throws ProviderKeyError('PROVIDER_KEY_MISSING') 既无密文也无 .env 回落
 */
export function getProviderKey(providerId: string): string {
  const row = providerRow(providerId);
  const hasCipher = !!(row && row.api_key_cipher && row.api_key_iv && row.api_key_tag);

  // ① 有密文 + 有主密钥 → 解密(走缓存)
  if (hasCipher && masterKey()) {
    const cached = _cache.get(providerId);
    if (cached && cached.updatedAt === row!.updated_at) return cached.key;
    try {
      const key = decryptKey(
        { cipher: row!.api_key_cipher!, iv: row!.api_key_iv!, tag: row!.api_key_tag!, keyVersion: row!.key_version },
        providerId, // AAD = provider.id
      );
      _cache.set(providerId, { key, updatedAt: row!.updated_at });
      return key;
    } catch {
      // 密文在但解不开:坏数据 / 换了 MASTER_KEY 没跑轮转。绝不静默 —— 抛错让 job FAIL。
      throw new ProviderKeyError('PROVIDER_KEY_DECRYPT_FAILED', `provider ${providerId} 密钥解密失败(检查 MASTER_KEY 或重新配置 key)`);
    }
  }

  // ② 回落 .env(无密文 OR 无主密钥)
  const envVar = ENV_FALLBACK[providerId];
  const envVal = envVar ? process.env[envVar] : undefined;
  if (envVal) return envVal;

  // ③ 都没有
  throw new ProviderKeyError('PROVIDER_KEY_MISSING', `provider ${providerId} 未配置 key(库内无密文,.env 也无)`);
}

/** admin 写/轮转某 provider 的明文 key:加密入库(AAD=id)+ 存 last4 + bump updated_at(令缓存失效)。
 *  无 MASTER_KEY → 抛错(不允许明文落库)。 */
export function setProviderKey(providerId: string, plainKey: string): void {
  if (!masterKey()) throw new ProviderKeyError('MASTER_KEY_MISSING', '未配置 MASTER_KEY,无法加密保存 key');
  if (!providerRow(providerId)) throw new ProviderKeyError('PROVIDER_NOT_FOUND', `provider ${providerId} 不存在`);
  const b = encryptKey(plainKey, providerId);
  db.prepare(
    `UPDATE provider SET api_key_cipher=?, api_key_iv=?, api_key_tag=?, key_version=?, api_key_last4=?, updated_at=? WHERE id=?`,
  ).run(b.cipher, b.iv, b.tag, b.keyVersion, lastFour(plainKey), Date.now(), providerId);
  _cache.delete(providerId); // 立即失效缓存
}

/** 测试/轮转脚本用:清缓存。 */
export function clearProviderKeyCache(): void {
  _cache.clear();
}
