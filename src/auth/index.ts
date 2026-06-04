// 灵镜 认证 — bcrypt 密码 + 服务器端 session。
//
// 决策来源:/plan-eng-review D16 —— server session(存 DB)而非 JWT,
// 因为政企客户要"管理员一键停用成员即生效":删 session / 停用 user 立刻断登录。

import { randomUUID, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import {
  db,
  type Role,
  type UserStatus,
  type TenantRow,
  type UserRow,
  type SessionRow,
} from '../db/index.js';

const now = () => Date.now();
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
const BCRYPT_ROUNDS = 10;

// ── 机构 ──
export function createTenant(name: string, delivery: 'hosted' | 'private' = 'hosted'): TenantRow {
  const DEFAULT_SEATS = 10; // 与 DB DEFAULT 一致;新机构默认 10 个创作席位
  const t: TenantRow = { id: randomUUID(), name, delivery, max_creator_seats: DEFAULT_SEATS, created_at: now() };
  db.prepare(`INSERT INTO tenant (id,name,delivery,max_creator_seats,created_at) VALUES (?,?,?,?,?)`).run(
    t.id,
    t.name,
    t.delivery,
    t.max_creator_seats,
    t.created_at,
  );
  return t;
}

// ── 成员管理 ──
//
// 业务错误统一带 code(前端按 code 分支,不 string-match 中文;同 credits INSUFFICIENT_CREDITS)。
export type MemberErrorCode = 'SEATS_FULL' | 'LAST_ADMIN' | 'SELF_ACTION' | 'INVALID_ROLE';
function memberErr(code: MemberErrorCode, message: string): Error {
  const e = new Error(message);
  (e as { code?: string }).code = code;
  return e;
}

// ── 席位 / 角色计数 helper(三处复用:createUser / setUserStatus / changeRole)──
// 持席位 = active + disabled 的 creator 总数。停用仍占席位,使停用可逆(停用后重新启用
// 不会因席位被别人抢占而失败);只有「移除(删除)」才真正释放席位。
function countCreatorsHoldingSeat(tenantId: string): number {
  const r = db
    .prepare(`SELECT COUNT(*) AS n FROM user WHERE tenant_id=? AND role='creator'`)
    .get(tenantId) as { n: number };
  return r.n;
}
function seatLimit(tenantId: string): number {
  const r = db
    .prepare(`SELECT max_creator_seats AS m FROM tenant WHERE id=?`)
    .get(tenantId) as { m: number } | undefined;
  return r?.m ?? 10;
}
/** 机构当前 active admin 数(锁死防护:不能让它归零)。 */
function countActiveAdmins(tenantId: string): number {
  const r = db
    .prepare(`SELECT COUNT(*) AS n FROM user WHERE tenant_id=? AND role='admin' AND status='active'`)
    .get(tenantId) as { n: number };
  return r.n;
}
/** 已用席位 + 上限(供统计卡)。 */
export function seatUsage(tenantId: string): { used: number; limit: number } {
  return { used: countCreatorsHoldingSeat(tenantId), limit: seatLimit(tenantId) };
}

export function createUser(
  tenantId: string,
  username: string,
  password: string,
  role: Role,
): UserRow {
  if (!['admin', 'creator', 'viewer'].includes(role)) throw memberErr('INVALID_ROLE', '角色非法');
  const u: UserRow = {
    id: randomUUID(),
    tenant_id: tenantId,
    username,
    display_name: username, // 默认昵称=用户名,可在个人信息里改
    password_hash: bcrypt.hashSync(password, BCRYPT_ROUNDS),
    role,
    status: 'active',
    last_active: null,
    created_at: now(),
  };
  // 事务内:席位校验(仅 creator)+ 用户名唯一校验 + 写入,串行化防 TOCTOU 超卖(同 credits.reserve)。
  const tx = db.transaction(() => {
    if (role === 'creator' && countCreatorsHoldingSeat(tenantId) >= seatLimit(tenantId)) {
      throw memberErr('SEATS_FULL', `创作席位已满(${countCreatorsHoldingSeat(tenantId)}/${seatLimit(tenantId)}),请升级套餐或移除其他创作者`);
    }
    // 用户名全局唯一:登录只凭账号即可定位租户,无需手输机构 ID。
    if (db.prepare(`SELECT 1 FROM user WHERE username=?`).get(username)) {
      throw new Error('用户名已被占用(全平台唯一,请换一个)');
    }
    db.prepare(
      `INSERT INTO user (id,tenant_id,username,display_name,password_hash,role,status,last_active,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(u.id, u.tenant_id, u.username, u.display_name, u.password_hash, u.role, u.status, u.last_active, u.created_at);
  });
  tx();
  return u;
}

/** 停用/启用成员。actingUserId:不能停用自己,也不能停用机构最后一个 active admin。
 *  事务内校验+写,串行化防双 admin 同时互停导致零 admin 锁死。 */
export function setUserStatus(
  tenantId: string,
  userId: string,
  status: 'active' | 'disabled',
  actingUserId?: string,
): boolean {
  const tx = db.transaction((): boolean => {
    const target = db
      .prepare(`SELECT role,status FROM user WHERE id=? AND tenant_id=?`)
      .get(userId, tenantId) as { role: Role; status: UserStatus } | undefined;
    if (!target) return false;
    if (status === 'disabled') {
      if (actingUserId && userId === actingUserId) throw memberErr('SELF_ACTION', '不能停用自己');
      if (target.role === 'admin' && target.status === 'active' && countActiveAdmins(tenantId) <= 1) {
        throw memberErr('LAST_ADMIN', '机构需至少保留一个管理员,不能停用最后一个');
      }
    }
    db.prepare(`UPDATE user SET status=? WHERE id=? AND tenant_id=?`).run(status, userId, tenantId);
    // 停用即作废其所有 session(政企"立即停用"需求)
    if (status === 'disabled') db.prepare(`DELETE FROM session WHERE user_id=?`).run(userId);
    return true;
  });
  return tx();
}

/** 移除成员(真正释放席位)。actingUserId:不能移除自己,也不能移除最后一个 active admin。 */
export function removeUser(tenantId: string, userId: string, actingUserId?: string): boolean {
  const tx = db.transaction((): boolean => {
    const target = db
      .prepare(`SELECT role,status FROM user WHERE id=? AND tenant_id=?`)
      .get(userId, tenantId) as { role: Role; status: UserStatus } | undefined;
    if (!target) return false;
    if (actingUserId && userId === actingUserId) throw memberErr('SELF_ACTION', '不能移除自己');
    if (target.role === 'admin' && target.status === 'active' && countActiveAdmins(tenantId) <= 1) {
      throw memberErr('LAST_ADMIN', '机构需至少保留一个管理员,不能移除最后一个');
    }
    db.prepare(`DELETE FROM session WHERE user_id=?`).run(userId);
    db.prepare(`DELETE FROM user WHERE id=? AND tenant_id=?`).run(userId, tenantId);
    return true;
  });
  return tx();
}

/** 改成员角色。闭合「role-change 绕过席位不变量」漏洞:
 *  →creator 走席位校验;admin→其他走 last-admin 校验;不能改自己角色。事务内串行化。 */
export function changeRole(
  tenantId: string,
  userId: string,
  newRole: Role,
  actingUserId?: string,
): boolean {
  if (!['admin', 'creator', 'viewer'].includes(newRole)) throw memberErr('INVALID_ROLE', '角色非法');
  const tx = db.transaction((): boolean => {
    const target = db
      .prepare(`SELECT role,status FROM user WHERE id=? AND tenant_id=?`)
      .get(userId, tenantId) as { role: Role; status: UserStatus } | undefined;
    if (!target) return false;
    if (actingUserId && userId === actingUserId) throw memberErr('SELF_ACTION', '不能修改自己的角色');
    if (target.role === newRole) return true; // 无变化,幂等
    // 升为 creator:占一个席位,需校验上限(目标当前不是 creator 才会新增占用)。
    if (newRole === 'creator' && countCreatorsHoldingSeat(tenantId) >= seatLimit(tenantId)) {
      throw memberErr('SEATS_FULL', `创作席位已满(${countCreatorsHoldingSeat(tenantId)}/${seatLimit(tenantId)}),请升级套餐或移除其他创作者`);
    }
    // admin 降级:不能动最后一个 active admin。
    if (target.role === 'admin' && target.status === 'active' && newRole !== 'admin' && countActiveAdmins(tenantId) <= 1) {
      throw memberErr('LAST_ADMIN', '机构需至少保留一个管理员,不能降级最后一个');
    }
    db.prepare(`UPDATE user SET role=? WHERE id=? AND tenant_id=?`).run(newRole, userId, tenantId);
    return true;
  });
  return tx();
}

export function listUsers(tenantId: string): Omit<UserRow, 'password_hash'>[] {
  return db
    .prepare(
      `SELECT id,tenant_id,username,display_name,role,status,last_active,created_at
       FROM user WHERE tenant_id=? ORDER BY created_at ASC`,
    )
    .all(tenantId) as Omit<UserRow, 'password_hash'>[];
}

// ── 登录 / 会话 ──
export interface AuthedUser {
  id: string;
  tenantId: string;
  tenantName: string;
  username: string;
  displayName: string;
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
  // 最近活跃 throttle 写:距上次 >5min 才 UPDATE,避免轮询场景每请求写库胀 WAL。
  // best-effort:吞错(含 SQLITE_BUSY),写失败绝不影响鉴权读路径。
  const ACTIVE_THROTTLE_MS = 5 * 60 * 1000;
  if (!u.last_active || now() - u.last_active > ACTIVE_THROTTLE_MS) {
    try {
      db.prepare(`UPDATE user SET last_active=? WHERE id=?`).run(now(), u.id);
    } catch {
      /* 活跃时间是 best-effort,写失败忽略 */
    }
  }
  const t = db.prepare(`SELECT name FROM tenant WHERE id=?`).get(u.tenant_id) as { name: string } | undefined;
  return {
    id: u.id, tenantId: u.tenant_id, tenantName: t?.name || '我的机构',
    username: u.username, displayName: u.display_name || u.username, role: u.role,
  };
}

/** 改昵称(展示名)。 */
export function updateDisplayName(userId: string, displayName: string): void {
  db.prepare(`UPDATE user SET display_name=? WHERE id=?`).run(displayName.trim() || null, userId);
}

/** 改密码:校验旧密码 → 写新 hash → 作废其它 session(强制重新登录,安全)。 */
export function changePassword(userId: string, oldPassword: string, newPassword: string, keepToken?: string): void {
  const u = db.prepare(`SELECT * FROM user WHERE id=?`).get(userId) as UserRow | undefined;
  if (!u) throw new Error('用户不存在');
  if (!bcrypt.compareSync(oldPassword, u.password_hash)) throw new Error('原密码错误');
  if (newPassword.length < 6) throw new Error('新密码至少 6 位');
  db.prepare(`UPDATE user SET password_hash=? WHERE id=?`).run(bcrypt.hashSync(newPassword, BCRYPT_ROUNDS), userId);
  // 改密后作废其它会话(保留当前这个,避免把自己踢下线)
  if (keepToken) db.prepare(`DELETE FROM session WHERE user_id=? AND token!=?`).run(userId, keepToken);
  else db.prepare(`DELETE FROM session WHERE user_id=?`).run(userId);
}
