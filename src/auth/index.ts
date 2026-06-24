// 灵镜 认证 — bcrypt 密码 + 服务器端 session。
//
// 决策来源:/plan-eng-review D16 —— server session(存 DB)而非 JWT,
// 因为政企客户要"管理员一键停用成员即生效":删 session / 停用 user 立刻断登录。

import { randomUUID } from 'node:crypto';
import {
  db,
  uniqueTenantSlug,
  type Role,
  type UserStatus,
  type TenantRow,
  type UserRow,
  type SessionRow,
} from '../db/index.js';
import { hashPassword, verifyPassword, dummyVerify, genToken, genTempPassword } from './crypto.js';
import { consumeSmsCode, consumeMessage } from './sms.js';
import { grant } from '../credits/index.js';

const now = () => Date.now();
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

// ── 机构 ──
export function createTenant(name: string, delivery: 'hosted' | 'private' = 'hosted'): TenantRow {
  const DEFAULT_SEATS = 10; // 与 DB DEFAULT 一致;新机构默认 10 个创作席位
  const t: TenantRow = {
    id: randomUUID(),
    name,
    delivery,
    max_creator_seats: DEFAULT_SEATS,
    created_at: now(),
    slug: uniqueTenantSlug(), // 落地页品牌识别用随机 slug,新建即赋
  };
  db.prepare(`INSERT INTO tenant (id,name,delivery,max_creator_seats,created_at,slug) VALUES (?,?,?,?,?,?)`).run(
    t.id,
    t.name,
    t.delivery,
    t.max_creator_seats,
    t.created_at,
    t.slug,
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

// 平台保留用户名:租户用户不能占用(大小写折叠后比对)。真正的隔离靠 platform_admin
// 独立表 + 独立 cookie + 独立端点(/plan-ceo-review B5)——这里只是 UX 防呆,避免租户
// 建一个叫 admin 的用户造成"我以为我是超管"的混淆,不承担安全职责。
const RESERVED_USERNAMES = new Set(['admin', 'administrator', 'root', 'superadmin', 'system']);

// 同步插入核心:席位校验(仅 creator)+ 用户名唯一 + 写入(含 phone)。串行化防 TOCTOU 超卖。
// 必须在事务内调用。供 createUser(密码 hash 后)与 loginOrRegisterByPhone(哨兵 '' 免 hash → 全同步)共用(DRY)。
function insertUserRow(u: UserRow): void {
  if (u.role === 'creator' && countCreatorsHoldingSeat(u.tenant_id) >= seatLimit(u.tenant_id)) {
    throw memberErr('SEATS_FULL', `创作席位已满(${countCreatorsHoldingSeat(u.tenant_id)}/${seatLimit(u.tenant_id)}),请升级套餐或移除其他创作者`);
  }
  // 用户名全局唯一:登录只凭账号即可定位租户,无需手输机构 ID。
  if (db.prepare(`SELECT 1 FROM user WHERE username=?`).get(u.username)) {
    throw new Error('用户名已被占用(全平台唯一,请换一个)');
  }
  db.prepare(
    `INSERT INTO user (id,tenant_id,username,display_name,password_hash,phone,role,status,last_active,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(u.id, u.tenant_id, u.username, u.display_name, u.password_hash, u.phone, u.role, u.status, u.last_active, u.created_at);
}

export async function createUser(
  tenantId: string,
  username: string,
  password: string,
  role: Role,
  displayName?: string, // 昵称(展示名);空则回落用户名(保旧调用兼容)
): Promise<UserRow> {
  if (!['admin', 'creator'].includes(role)) throw memberErr('INVALID_ROLE', '角色非法');
  if (RESERVED_USERNAMES.has(username.trim().toLowerCase())) {
    throw new Error('该用户名为平台保留字,请换一个(如机构简称+姓名)');
  }
  const passwordHash = await hashPassword(password); // bcrypt 异步,在开事务前算好(事务体内不能 await)
  const u: UserRow = {
    id: randomUUID(),
    tenant_id: tenantId,
    username,
    display_name: (displayName && displayName.trim()) || username, // 昵称优先;空回落用户名
    password_hash: passwordHash,
    phone: null, // 后台开户的成员无手机号;手机号自助注册走 loginOrRegisterByPhone
    role,
    status: 'active',
    last_active: null,
    created_at: now(),
  };
  db.transaction(() => insertUserRow(u))();
  return u;
}

/** 是否已设密码。哨兵 '' = 未设(手机号自助注册用户,Fork1)。判定只此一处,防「is-password-user」两处漂移(外部声音#2)。 */
export function userHasPassword(u: { password_hash: string }): boolean {
  return !!u.password_hash;
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
  if (!['admin', 'creator'].includes(newRole)) throw memberErr('INVALID_ROLE', '角色非法');
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

// ── 平台超管专用(在租户之上,无旧密码校验)──
//
// 与租户自助操作的区别:超管重置密码不需要旧密码(运营帮租户找回),且作废该用户
// 所有 session 强制重登。租户名改:租户侧只读(ORG_NAME_READONLY),仅超管能改。

/** 超管重置某用户密码(免旧密码)。重置后作废其所有 session。返回 false=用户不存在。 */
export async function adminResetPassword(tenantId: string, userId: string, newPassword: string): Promise<boolean> {
  if (!newPassword || newPassword.length < 6) throw new Error('新密码至少 6 位');
  const u = db.prepare(`SELECT 1 FROM user WHERE id=? AND tenant_id=?`).get(userId, tenantId);
  if (!u) return false;
  const passwordHash = await hashPassword(newPassword); // 事务前算好(事务体不能 await)
  const tx = db.transaction(() => {
    db.prepare(`UPDATE user SET password_hash=? WHERE id=? AND tenant_id=?`).run(passwordHash, userId, tenantId);
    db.prepare(`DELETE FROM session WHERE user_id=?`).run(userId); // 作废所有 session,强制重登
  });
  tx();
  return true;
}

/** 租户 admin 强制重置成员密码:生成随机强密码 → adminResetPassword(作废 session)。
 *  自我保护:不能重置自己(改自己密码走 /me/password,需旧密码)。
 *  返回 {username, password}(明文仅此次回传,不落库、不写审计);用户不存在 → null。 */
export async function tenantAdminResetPassword(
  tenantId: string,
  userId: string,
  actingUserId: string,
): Promise<{ username: string; password: string } | null> {
  if (userId === actingUserId) {
    throw memberErr('SELF_ACTION', '不能重置自己的密码,请在个人信息中修改');
  }
  const u = db
    .prepare(`SELECT username FROM user WHERE id=? AND tenant_id=?`)
    .get(userId, tenantId) as { username: string } | undefined;
  if (!u) return null;
  const password = genTempPassword();
  await adminResetPassword(tenantId, userId, password); // 复用:写 hash + 作废 session(租户隔离已校验);bcrypt 异步须 await
  return { username: u.username, password };
}

/** 超管改租户配置(name / max_creator_seats / delivery)。只更新传入的字段。返回 false=租户不存在。 */
export function updateTenant(
  tenantId: string,
  patch: { name?: string; maxCreatorSeats?: number; delivery?: 'hosted' | 'private' },
): boolean {
  const t = db.prepare(`SELECT 1 FROM tenant WHERE id=?`).get(tenantId);
  if (!t) return false;
  const sets: string[] = [];
  const vals: (string | number)[] = [];
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new Error('机构名称不能为空');
    sets.push('name=?'); vals.push(name);
  }
  if (patch.maxCreatorSeats !== undefined) {
    if (!Number.isInteger(patch.maxCreatorSeats) || patch.maxCreatorSeats < 1) throw new Error('席位上限须为正整数');
    // 不能把上限降到低于当前持席位创作者数(否则现有创作者被锁,统计卡显示超额)
    const held = countCreatorsHoldingSeat(tenantId);
    if (patch.maxCreatorSeats < held) throw new Error(`席位上限不能低于当前已用席位数(${held})`);
    sets.push('max_creator_seats=?'); vals.push(patch.maxCreatorSeats);
  }
  if (patch.delivery !== undefined) {
    if (patch.delivery !== 'hosted' && patch.delivery !== 'private') throw new Error('交付模式非法');
    sets.push('delivery=?'); vals.push(patch.delivery);
  }
  if (!sets.length) return true; // 无字段变更,幂等
  vals.push(tenantId);
  db.prepare(`UPDATE tenant SET ${sets.join(', ')} WHERE id=?`).run(...vals);
  return true;
}

// ── 登录 / 会话 ──
// 机构未自定义名称时的默认名(平台开通账号时若没给名,DB 也可能存这个)。
// 单一真相源:isCustomBranded 的判定只在此处比较,客户端不复制这个串。
const DEFAULT_TENANT_NAME = '我的机构';

export interface AuthedUser {
  id: string;
  tenantId: string;
  tenantName: string; // 机构名称(tenant.name)= 官方身份,只读
  brandName: string; // 系统名称(品牌显示名):brand_name ?? tenantName;侧边栏/落地页用此显示
  orgLogoKey: string | null; // 机构 logo 存储 key,前端据此拼 /api/org-logo/<tenant>(空则用默认图标)
  isCustomBranded: boolean; // 是否已自定义品牌(设过 logo / 系统名 / 机构名非默认);前端据此决定换不换侧边栏品牌
  logoVer: string; // logo 缓存破位符(= logo key 片段);改名/换/恢复后变 → URL ?v= 立即刷新
  username: string;
  displayName: string;
  role: Role;
  phone: string | null; // 绑定手机号(脱敏前端再处理);未绑定为 null(账户页提示绑定,#9)
  hasPassword: boolean; // 是否已设密码;false → 账户页提示设密码(#7)
}

/** 用 (username, password) 登录(用户名全局唯一,租户从账号反查),成功返回 session token。 */
export async function login(username: string, password: string): Promise<string> {
  const u = db
    .prepare(`SELECT * FROM user WHERE username=?`)
    .get(username) as UserRow | undefined;
  // 统一报错文案,避免泄露"用户是否存在"
  const fail = () => new Error('用户名或密码错误');
  if (!u) {
    await dummyVerify(password); // 抵消时序差异
    throw fail();
  }
  if (u.status === 'disabled') throw new Error('账号已被停用');
  // 哨兵 '' = 未设密码(手机号注册用户):密码登录不通,引导走验证码。dummyVerify 抵时序。
  if (!userHasPassword(u)) { await dummyVerify(password); throw new Error('该账号未设置密码,请用验证码登录'); }
  if (!(await verifyPassword(password, u.password_hash))) throw fail();

  const token = genToken();
  const t = now();
  db.prepare(
    `INSERT INTO session (token,user_id,tenant_id,created_at,expires_at) VALUES (?,?,?,?,?)`,
  ).run(token, u.id, u.tenant_id, t, t + SESSION_TTL_MS);
  return token;
}

export function logout(token: string): void {
  db.prepare(`DELETE FROM session WHERE token=?`).run(token);
}

// ── 手机验证码登录 / 自助注册(统一入口,需求#5/#6;/plan-ceo-review + /plan-eng-review)──
/** 写 session 行,返回 token(供密码登录与手机登录共用)。 */
function mintSession(userId: string, tenantId: string): string {
  const token = genToken();
  const t = now();
  db.prepare(
    `INSERT INTO session (token,user_id,tenant_id,created_at,expires_at) VALUES (?,?,?,?,?)`,
  ).run(token, userId, tenantId, t, t + SESSION_TTL_MS);
  return token;
}

export type PhoneAuthResult =
  | { ok: true; token: string; isNew: boolean; userId: string; tenantId: string }
  | { ok: false; error: string };

/** 验证码登录或注册(同一入口,验码已在此事务内消费)。
 *  老号 → 直接登录(#6);新号 → 建机构(默认名)+ 设为 admin(username=phone,哨兵 '' 免密)+ 试用积分(#5)。
 *  哨兵 '' 免 bcrypt → 全同步:createTenant + insertUserRow + grant + mintSession 同一事务,失败全回滚
 *  (含并发同号:UNIQUE(phone) 让后到者插入失败 → 抛错回滚 → 前端重试走登录分支)。 */
export const loginOrRegisterByPhone = db.transaction(
  (phone: string, code: string, ip: string | null): PhoneAuthResult => {
    const consume = consumeSmsCode(phone, 'login', code, ip);
    if (consume !== 'ok') return { ok: false, error: consumeMessage(consume)! };
    const existing = db
      .prepare(`SELECT id, tenant_id, status FROM user WHERE phone=?`)
      .get(phone) as { id: string; tenant_id: string; status: UserStatus } | undefined;
    if (existing) {
      if (existing.status === 'disabled') return { ok: false, error: '账号已被停用' };
      const token = mintSession(existing.id, existing.tenant_id);
      return { ok: true, token, isNew: false, userId: existing.id, tenantId: existing.tenant_id };
    }
    // 新号:建机构(默认名「我的机构」,admin 可在账户页改 brand_name)+ admin 用户(无密码)。
    const tenant = createTenant(DEFAULT_TENANT_NAME, 'hosted');
    const u: UserRow = {
      id: randomUUID(), tenant_id: tenant.id, username: phone, display_name: phone,
      password_hash: '', phone, role: 'admin', status: 'active', last_active: null, created_at: now(),
    };
    insertUserRow(u);
    // 试用积分:运营可在 platform_config 调(0=不送);受同套发送/注册防滥用闸约束(已知 COGS 风险)。
    const trial = Number(
      (db.prepare(`SELECT value FROM platform_config WHERE key='self_serve_trial_credits'`).get() as { value?: string } | undefined)?.value,
    ) || 0;
    if (trial > 0) grant(tenant.id, trial, '自助注册试用积分');
    const token = mintSession(u.id, tenant.id);
    return { ok: true, token, isNew: true, userId: u.id, tenantId: tenant.id };
  },
);

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
  // 机构 logo key(供前端拼公开读路径;不在此签名,零额外开销)。
  const logoRow = db
    .prepare(`SELECT value FROM tenant_setting WHERE tenant_id=? AND key='org_logo_key'`)
    .get(u.tenant_id) as { value: string } | undefined;
  const tenantName = t?.name || DEFAULT_TENANT_NAME;
  const orgLogoKey = logoRow?.value ?? null;
  // 系统名称(品牌显示名):管理员设的 brand_name,未设则回落机构名(行为不变)。
  const brandRow = db
    .prepare(`SELECT value FROM tenant_setting WHERE tenant_id=? AND key='brand_name'`)
    .get(u.tenant_id) as { value: string } | undefined;
  const brandName = brandRow?.value || tenantName;
  // 显式品牌哨兵:设过 logo / 系统名,或机构名非平台默认 → 已自定义。判定只在服务端(此处),
  // 客户端只读布尔,不复制 '我的机构' 魔术串(避免双处同步负担 + 误判真名「我的机构」的租户)。
  const isCustomBranded = !!orgLogoKey || !!brandRow?.value || tenantName !== DEFAULT_TENANT_NAME;
  return {
    id: u.id, tenantId: u.tenant_id, tenantName, brandName,
    orgLogoKey,
    isCustomBranded,
    logoVer: orgLogoKey ? orgLogoKey.slice(-12) : '0', // 换/恢复 logo 后变 → ?v= 破缓存
    username: u.username, displayName: u.display_name || u.username, role: u.role,
    phone: u.phone, hasPassword: userHasPassword(u),
  };
}

/** 改昵称(展示名)。 */
export function updateDisplayName(userId: string, displayName: string): void {
  db.prepare(`UPDATE user SET display_name=? WHERE id=?`).run(displayName.trim() || null, userId);
}

/** 改密码:校验旧密码 → 写新 hash → 作废其它 session(强制重新登录,安全)。 */
export async function changePassword(userId: string, oldPassword: string, newPassword: string, keepToken?: string): Promise<void> {
  const u = db.prepare(`SELECT * FROM user WHERE id=?`).get(userId) as UserRow | undefined;
  if (!u) throw new Error('用户不存在');
  if (!(await verifyPassword(oldPassword, u.password_hash))) throw new Error('原密码错误');
  if (newPassword.length < 6) throw new Error('新密码至少 6 位');
  const passwordHash = await hashPassword(newPassword);
  db.prepare(`UPDATE user SET password_hash=? WHERE id=?`).run(passwordHash, userId);
  // 改密后作废其它会话(保留当前这个,避免把自己踢下线)
  if (keepToken) db.prepare(`DELETE FROM session WHERE user_id=? AND token!=?`).run(userId, keepToken);
  else db.prepare(`DELETE FROM session WHERE user_id=?`).run(userId);
}
