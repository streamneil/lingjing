// 灵镜 认证 — bcrypt 密码 + 服务器端 session。
//
// 决策来源:/plan-eng-review D16 —— server session(存 DB)而非 JWT,
// 因为政企客户要"管理员一键停用成员即生效":删 session / 停用 user 立刻断登录。

import { randomUUID, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import {
  db,
  type Role,
  type TenantRow,
  type UserRow,
  type SessionRow,
} from '../db/index.js';

const now = () => Date.now();
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
const BCRYPT_ROUNDS = 10;

// ── 机构 ──
export function createTenant(name: string, delivery: 'hosted' | 'private' = 'hosted'): TenantRow {
  const t: TenantRow = { id: randomUUID(), name, delivery, created_at: now() };
  db.prepare(`INSERT INTO tenant (id,name,delivery,created_at) VALUES (?,?,?,?)`).run(
    t.id,
    t.name,
    t.delivery,
    t.created_at,
  );
  return t;
}

// ── 成员 ──
export function createUser(
  tenantId: string,
  username: string,
  password: string,
  role: Role,
): UserRow {
  // 用户名全局唯一:登录只凭账号即可定位租户,无需手输机构 ID。
  const exists = db.prepare(`SELECT 1 FROM user WHERE username=?`).get(username);
  if (exists) throw new Error('用户名已被占用(全平台唯一,请换一个)');

  const u: UserRow = {
    id: randomUUID(),
    tenant_id: tenantId,
    username,
    password_hash: bcrypt.hashSync(password, BCRYPT_ROUNDS),
    role,
    status: 'active',
    created_at: now(),
  };
  db.prepare(
    `INSERT INTO user (id,tenant_id,username,password_hash,role,status,created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(u.id, u.tenant_id, u.username, u.password_hash, u.role, u.status, u.created_at);
  return u;
}

export function setUserStatus(tenantId: string, userId: string, status: 'active' | 'disabled'): boolean {
  const res = db
    .prepare(`UPDATE user SET status=? WHERE id=? AND tenant_id=?`)
    .run(status, userId, tenantId);
  // 停用即作废其所有 session(政企"立即停用"需求)
  if (status === 'disabled') db.prepare(`DELETE FROM session WHERE user_id=?`).run(userId);
  return res.changes === 1;
}

export function removeUser(tenantId: string, userId: string): boolean {
  db.prepare(`DELETE FROM session WHERE user_id=?`).run(userId);
  const res = db.prepare(`DELETE FROM user WHERE id=? AND tenant_id=?`).run(userId, tenantId);
  return res.changes === 1;
}

export function listUsers(tenantId: string): Omit<UserRow, 'password_hash'>[] {
  return db
    .prepare(`SELECT id,tenant_id,username,role,status,created_at FROM user WHERE tenant_id=?`)
    .all(tenantId) as Omit<UserRow, 'password_hash'>[];
}

// ── 登录 / 会话 ──
export interface AuthedUser {
  id: string;
  tenantId: string;
  username: string;
  role: Role;
}

/** 用 (username, password) 登录(用户名全局唯一,租户从账号反查),成功返回 session token。 */
export function login(username: string, password: string): string {
  const u = db
    .prepare(`SELECT * FROM user WHERE username=?`)
    .get(username) as UserRow | undefined;
  // 统一报错文案,避免泄露"用户是否存在"
  const fail = () => new Error('用户名或密码错误');
  if (!u) {
    bcrypt.compareSync(password, '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinv'); // 抵消时序差异
    throw fail();
  }
  if (u.status === 'disabled') throw new Error('账号已被停用');
  if (!bcrypt.compareSync(password, u.password_hash)) throw fail();

  const token = randomBytes(32).toString('hex');
  const t = now();
  db.prepare(
    `INSERT INTO session (token,user_id,tenant_id,created_at,expires_at) VALUES (?,?,?,?,?)`,
  ).run(token, u.id, u.tenant_id, t, t + SESSION_TTL_MS);
  return token;
}

export function logout(token: string): void {
  db.prepare(`DELETE FROM session WHERE token=?`).run(token);
}

/** 校验 session token,返回当前用户(含最新角色/状态),无效返回 null。 */
export function resolveSession(token: string | undefined): AuthedUser | null {
  if (!token) return null;
  const s = db.prepare(`SELECT * FROM session WHERE token=?`).get(token) as SessionRow | undefined;
  if (!s) return null;
  if (s.expires_at < now()) {
    db.prepare(`DELETE FROM session WHERE token=?`).run(token);
    return null;
  }
  // 每次都查 user 最新状态:停用即生效(JWT 做不到这点)
  const u = db.prepare(`SELECT * FROM user WHERE id=?`).get(s.user_id) as UserRow | undefined;
  if (!u || u.status === 'disabled') return null;
  return { id: u.id, tenantId: u.tenant_id, username: u.username, role: u.role };
}
