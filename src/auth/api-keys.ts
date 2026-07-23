// 灵镜 Open API — API key 体系(设计文档 §4.1/4.2)。
//
// key == 成员本人:key 以创建者身份行动,权限/计费/作品归属全走现有逻辑,零新概念。
//   - 认证:resolveApiKey 解析 Authorization: Bearer lj_sk_…,哈希查表(未吊销),
//     查 user 最新状态(停用→null,同 resolveSession),构造与 session 逐字段一致的 AuthedUser。
//   - 无生命周期联动(产品决策):唯一保障是每请求查最新状态;主人停用即 401,免费获得。
//   - admin 可见并吊销全租户所有 key;成员只见/吊销自己的。余额即消费上限(不做 per-key 配额)。

import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import type { UserRow } from '../db/index.js';
import { genApiKey, hashApiKey, API_KEY_PREFIX } from './crypto.js';
import { buildAuthedUser, touchLastActive, type AuthedUser } from './index.js';
import { masterKey, encryptKey, decryptKey } from '../gateway/key-crypto.js';

export interface ApiKeyRow {
  id: string;
  tenant_id: string;
  user_id: string;
  name: string;
  key_prefix: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  owner_name: string | null; // 主人显示名(JOIN user);设置页 admin 视图「谁的 key」用
}

const now = (): number => Date.now();

/** 创建 API key。返回明文 + id + 前缀。库里存:sha256 哈希(用于认证)+ AES-256-GCM 密文(用于随时复现,AAD=id)。
 *  未配 MASTER_KEY 时只存哈希(密文空,不可复现,行为回落"只显示一次")。 */
export function createApiKey(
  tenantId: string,
  userId: string,
  name: string,
): { id: string; key: string; prefix: string } {
  const { key, prefix } = genApiKey();
  const id = randomUUID();
  // 有主密钥 → 加密存明文(AAD=id 绑定行,防行间搬移);无 → 密文列留空。
  const enc = masterKey() ? encryptKey(key, id) : null;
  db.prepare(
    `INSERT INTO api_key (id,tenant_id,user_id,name,key_hash,key_prefix,created_at,key_cipher,key_iv,key_tag,key_version)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, tenantId, userId, name, hashApiKey(key), prefix, now(),
    enc?.cipher ?? null, enc?.iv ?? null, enc?.tag ?? null, enc?.keyVersion ?? null);
  return { id, key, prefix };
}

/** 复现明文密钥(供随时复制)。仅限本人(admin 也不能看别人的明文——最小权限)。
 *  返回 {key} / {recoverable:false}(旧库无密文或未配 MASTER_KEY)/ null(不存在或非本人)。 */
export function revealApiKey(id: string, tenantId: string, userId: string): { key: string } | { recoverable: false } | null {
  const row = db
    .prepare(`SELECT key_cipher, key_iv, key_tag, key_version FROM api_key WHERE id=? AND tenant_id=? AND user_id=?`)
    .get(id, tenantId, userId) as { key_cipher: Buffer | null; key_iv: Buffer | null; key_tag: Buffer | null; key_version: number | null } | undefined;
  if (!row) return null;
  if (!row.key_cipher || !row.key_iv || !row.key_tag) return { recoverable: false };
  try {
    const key = decryptKey({ cipher: row.key_cipher, iv: row.key_iv, tag: row.key_tag, keyVersion: row.key_version ?? 1 }, id);
    return { key };
  } catch {
    return { recoverable: false }; // MASTER_KEY 轮换/不符 → 解不出,当不可复现
  }
}

/** 解析 Authorization 头(Bearer lj_sk_…)→ {与 session 一致的 AuthedUser, key id},或 null。
 *  校验链:形状 → 哈希查未吊销 key → 查 user 最新状态(停用→null)→ 更新 last_used(节流)。
 *  返回 keyId 供限速(每 key 计数)与审计标记(via_api_key)用。 */
export function resolveApiKeyFull(
  authHeader: string | undefined,
): { user: AuthedUser; keyId: string } | null {
  if (!authHeader || typeof authHeader !== 'string') return null;
  const m = authHeader.match(/^Bearer\s+(\S+)$/);
  if (!m) return null;
  const key = m[1]!;
  if (!key.startsWith(API_KEY_PREFIX)) return null;

  const row = db
    .prepare(`SELECT id, user_id, revoked_at, last_used_at FROM api_key WHERE key_hash=?`)
    .get(hashApiKey(key)) as { id: string; user_id: string; revoked_at: number | null; last_used_at: number | null } | undefined;
  if (!row || row.revoked_at != null) return null;

  // 每请求查 user 最新状态:停用即失效(同 resolveSession,无生命周期联动却仍即时生效)。
  const u = db.prepare(`SELECT * FROM user WHERE id=?`).get(row.user_id) as UserRow | undefined;
  if (!u || u.status === 'disabled') return null;

  // last_used_at 节流写(>5min 才更新),best-effort:同 touchLastActive 的写路径不阻塞鉴权。
  const ACTIVE_THROTTLE_MS = 5 * 60 * 1000;
  if (!row.last_used_at || now() - row.last_used_at > ACTIVE_THROTTLE_MS) {
    try {
      db.prepare(`UPDATE api_key SET last_used_at=? WHERE id=?`).run(now(), row.id);
    } catch {
      /* best-effort,写失败忽略 */
    }
  }
  touchLastActive(u); // 用户维度活跃也刷新(与网页端一致)
  return { user: buildAuthedUser(u), keyId: row.id };
}

/** resolveApiKeyFull 的薄包装:只要身份(不要 key id)。 */
export function resolveApiKey(authHeader: string | undefined): AuthedUser | null {
  return resolveApiKeyFull(authHeader)?.user ?? null;
}

/** 列 key。成员看自己的;admin 看全租户。永不含哈希(只前缀 + 元数据 + 主人显示名)。 */
export function listApiKeys(tenantId: string, userId: string, isAdmin: boolean): ApiKeyRow[] {
  const cols = `k.id, k.tenant_id, k.user_id, k.name, k.key_prefix, k.created_at, k.last_used_at, k.revoked_at,
                COALESCE(u.display_name, u.username) AS owner_name`;
  const join = `LEFT JOIN user u ON u.id = k.user_id`;
  const rows = isAdmin
    ? db.prepare(`SELECT ${cols} FROM api_key k ${join} WHERE k.tenant_id=? ORDER BY k.created_at DESC`).all(tenantId)
    : db
        .prepare(`SELECT ${cols} FROM api_key k ${join} WHERE k.tenant_id=? AND k.user_id=? ORDER BY k.created_at DESC`)
        .all(tenantId, userId);
  return rows as ApiKeyRow[];
}

/** 禁用 key(软删,留痕/留审计,行仍在)。成员只能禁用自己的;admin 可禁用本租户任意。
 *  返回是否真正禁用了一条「本租户、(admin 或本人)、未禁用」的 key(幂等:已禁用/够不到 → false)。 */
export function revokeApiKey(id: string, tenantId: string, userId: string, isAdmin: boolean): boolean {
  const res = isAdmin
    ? db
        .prepare(`UPDATE api_key SET revoked_at=? WHERE id=? AND tenant_id=? AND revoked_at IS NULL`)
        .run(now(), id, tenantId)
    : db
        .prepare(
          `UPDATE api_key SET revoked_at=? WHERE id=? AND tenant_id=? AND user_id=? AND revoked_at IS NULL`,
        )
        .run(now(), id, tenantId, userId);
  return res.changes > 0;
}

/** 删除 key(硬删,行移除)。成员只能删自己的;admin 可删本租户任意。已禁用的也能删。
 *  返回是否真正删了一行(够不到 → false)。 */
export function deleteApiKey(id: string, tenantId: string, userId: string, isAdmin: boolean): boolean {
  const res = isAdmin
    ? db.prepare(`DELETE FROM api_key WHERE id=? AND tenant_id=?`).run(id, tenantId)
    : db.prepare(`DELETE FROM api_key WHERE id=? AND tenant_id=? AND user_id=?`).run(id, tenantId, userId);
  return res.changes > 0;
}
