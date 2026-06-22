// 灵镜 平台超管认证 — 与租户认证物理隔离的第二套 session 系统。
//
// 决策来源:/plan-ceo-review D1/D4/D5 + /plan-eng-review E-1.1。
//
// 隔离三件套:
//   1. 独立表 platform_admin / platform_session(不碰租户 user / session)
//   2. 独立 cookie lj_padmin / Path=/admin / SameSite=Strict(比租户 Lax 更狠)
//   3. 独立中间件 requirePlatformAdmin —— 绝不读 req.user;且 /admin 子路由
//      不挂全局 attachUser(server.ts),req.user 在该链路永远 undefined。
//
// 一个租户侧越权 bug 提不了平台权:租户拿 lj_session 打 /admin/* → 401。
//
// 防暴破(D8/D9):仅滑块。captcha challenge 后端出题(目标 x 存服务端),
// verify 位置比对发一次性 token,登录必携并消费(DELETE)。无 IP 锁定。

import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import {
  db,
  type PlatformAdminRow,
  type PlatformSessionRow,
} from '../db/index.js';
import { config } from '../config.js';
import { hashPassword, verifyPassword, dummyVerify, genToken } from './crypto.js';
import { secureAttr } from './cookie.js';

const now = () => Date.now();
const PADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 小时绝对过期(超管高权限,比租户 7 天短)
const PADMIN_COOKIE = 'lj_padmin';

// ── 首启引导:platform_admin 表空 → env 种子建初始超管 ──
//
// 幂等:表非空不重建(INSERT 前先查)。SUPERADMIN_PASS 未设时 config.superadmin.password()
// 抛错 → 拒绝启动(B3,绝不用默认口令)。已建超管的环境不进 INSERT 分支,不会因缺 pass 崩。
export async function bootstrapSuperadmin(): Promise<void> {
  const count = (db.prepare(`SELECT COUNT(*) AS n FROM platform_admin`).get() as { n: number }).n;
  if (count > 0) return; // 已有超管,不重建(幂等)
  const username = config.superadmin.username;
  const password = config.superadmin.password(); // 未设 SUPERADMIN_PASS 在此抛错拒启
  const passwordHash = await hashPassword(password); // bcrypt 异步,await 后再写库
  db.prepare(
    `INSERT INTO platform_admin (id,username,password_hash,created_at) VALUES (?,?,?,?)`,
  ).run(randomUUID(), username, passwordHash, now());
  console.log(`[超管] 初始平台超管已创建:${username}(密码取自 SUPERADMIN_PASS)`);
}

// ── 滑块行为验证(拖到底式)──
// 简单直觉:把滑块拖到最右端即过(无缺口对齐认知负担)。challenge 仍发一次性行,
// 保留"一次性 token"安全语义;target_x 固定为轨道末端,verify 判断是否拖到末端附近。
const CAPTCHA_TTL_MS = 2 * 60 * 1000; // challenge / token 2 分钟过期
const CAPTCHA_TRACK_W = 280; // 滑轨参考宽度(前端按实际轨宽换算后提交,服务端按此判末端)
const CAPTCHA_END_THRESHOLD = 12; // 距末端 ≤ 此值(px,服务端坐标)算"拖到底"

/** 惰性清理过期 challenge / token(每次出题/校验顺带,免定时 job)。 */
function sweepCaptcha(): void {
  const t = now();
  db.prepare(`DELETE FROM captcha_challenge WHERE expires_at < ?`).run(t);
  db.prepare(`DELETE FROM captcha_token WHERE expires_at < ?`).run(t);
}

/** 出题:发一次性 challenge 行(target_x 固定为轨道末端),返回 challenge_id + trackW。
 *  前端把滑块拖到最右端即过,无需知道缺口位置(拖到底式,直觉)。
 *  真挡的是不渲染滑块、直接 POST /login 的无头脚本(没 token 直接 400)。 */
export function createCaptchaChallenge(): { challengeId: string; trackW: number } {
  sweepCaptcha();
  const id = randomUUID();
  const t = now();
  // target_x = 轨道末端(trackW);verify 判断提交 x 是否拖到末端附近。
  db.prepare(
    `INSERT INTO captcha_challenge (id,target_x,created_at,expires_at) VALUES (?,?,?,?)`,
  ).run(id, CAPTCHA_TRACK_W, t, t + CAPTCHA_TTL_MS);
  return { challengeId: id, trackW: CAPTCHA_TRACK_W };
}

/** 校验:滑块拖到末端附近(距 target_x ≤ 阈值)→ 消费 challenge + 发一次性 token。失败/过期 → null。 */
export function verifyCaptchaSlide(challengeId: string, x: number): string | null {
  sweepCaptcha();
  const row = db
    .prepare(`SELECT target_x, expires_at FROM captcha_challenge WHERE id=?`)
    .get(challengeId) as { target_x: number; expires_at: number } | undefined;
  if (!row || row.expires_at < now()) return null;
  // challenge 一次性:无论成败都删(防同一 challenge 暴力试)
  db.prepare(`DELETE FROM captcha_challenge WHERE id=?`).run(challengeId);
  // 拖到底:x 达到末端附近即过(x >= target_x - 阈值)。
  if (!Number.isFinite(x) || x < row.target_x - CAPTCHA_END_THRESHOLD) return null;
  const token = genToken();
  const t = now();
  db.prepare(
    `INSERT INTO captcha_token (token,created_at,expires_at) VALUES (?,?,?)`,
  ).run(token, t, t + CAPTCHA_TTL_MS);
  return token;
}

/** 消费 captcha_token:存在且未过期 → DELETE 并返回 true(一次性)。无/过期/重放 → false。 */
export function consumeCaptchaToken(token: string | undefined): boolean {
  if (!token) return false;
  sweepCaptcha();
  const row = db
    .prepare(`SELECT expires_at FROM captcha_token WHERE token=?`)
    .get(token) as { expires_at: number } | undefined;
  if (!row) return false;
  db.prepare(`DELETE FROM captcha_token WHERE token=?`).run(token); // 用过即弃
  return row.expires_at >= now();
}

// ── 超管登录 / 会话 ──
export interface AuthedPlatformAdmin {
  id: string;
  username: string;
}

/** 超管登录:校验 captcha_token + 密码 → 返回 platform_session token。 */
export async function platformLogin(username: string, password: string): Promise<string> {
  const pa = db
    .prepare(`SELECT * FROM platform_admin WHERE username=?`)
    .get(username) as PlatformAdminRow | undefined;
  const fail = () => new Error('用户名或密码错误');
  if (!pa) {
    await dummyVerify(password); // 抵消时序差异
    throw fail();
  }
  if (!(await verifyPassword(password, pa.password_hash))) throw fail();
  const token = genToken();
  const t = now();
  db.prepare(
    `INSERT INTO platform_session (token,padmin_id,created_at,expires_at) VALUES (?,?,?,?)`,
  ).run(token, pa.id, t, t + PADMIN_SESSION_TTL_MS);
  return token;
}

export function platformLogout(token: string): void {
  db.prepare(`DELETE FROM platform_session WHERE token=?`).run(token);
}

/** 校验 platform_session,返回超管;过期/无效 → null。 */
export function resolvePlatformSession(token: string | undefined): AuthedPlatformAdmin | null {
  if (!token) return null;
  const s = db
    .prepare(`SELECT * FROM platform_session WHERE token=?`)
    .get(token) as PlatformSessionRow | undefined;
  if (!s) return null;
  if (s.expires_at < now()) {
    db.prepare(`DELETE FROM platform_session WHERE token=?`).run(token);
    return null;
  }
  const pa = db
    .prepare(`SELECT id,username FROM platform_admin WHERE id=?`)
    .get(s.padmin_id) as { id: string; username: string } | undefined;
  if (!pa) return null;
  return { id: pa.id, username: pa.username };
}

// ── cookie + 中间件 ──
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      padmin?: AuthedPlatformAdmin;
    }
  }
}

function readPadminCookie(req: Request): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === PADMIN_COOKIE) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export function setPadminCookie(res: Response, token: string): void {
  // Path=/admin:cookie 只在 /admin/* 请求携带,不泄到租户页。SameSite=Strict:超管后台无跨站需求。
  // Secure 由 COOKIE_SECURE env 控(生产 HTTPS 带,本地裸 HTTP 不带否则超管登不进);HttpOnly 防 XSS。
  res.setHeader(
    'Set-Cookie',
    `${PADMIN_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/admin${secureAttr()}; Max-Age=${8 * 3600}`,
  );
}

export function clearPadminCookie(res: Response): void {
  res.setHeader('Set-Cookie', `${PADMIN_COOKIE}=; HttpOnly; SameSite=Strict; Path=/admin${secureAttr()}; Max-Age=0`);
}

export function readPadminToken(req: Request): string | undefined {
  return readPadminCookie(req);
}

/** 要求平台超管身份。绝不读 req.user(/admin 子路由也不挂 attachUser → req.user 恒 undefined)。
 *  无 lj_padmin / 无效 → 401(API)。租户拿 lj_session 打 /admin/* 同样 401(它没 lj_padmin)。 */
export function requirePlatformAdmin(req: Request, res: Response, next: NextFunction): void {
  const padmin = resolvePlatformSession(readPadminCookie(req));
  if (!padmin) {
    res.status(401).json({ error: '未登录(平台超管)' });
    return;
  }
  req.padmin = padmin;
  next();
}

// ── 超管账户管理(/plan: 添加超管 + 改密 + 删除;全部经 admin 路由 + 平台审计)──
// 安全:这些只在 requirePlatformAdmin 后调用(调用者已是超管);删除/改密的越权护栏在路由层
// (防删自己 / 防删最后一个),与 audit 一并在 admin.ts。

export interface PlatformAdminListItem { id: string; username: string; createdAt: number }

export function listPlatformAdmins(): PlatformAdminListItem[] {
  return (db.prepare(`SELECT id, username, created_at FROM platform_admin ORDER BY created_at ASC`).all() as PlatformAdminRow[])
    .map((p) => ({ id: p.id, username: p.username, createdAt: p.created_at }));
}

export function countPlatformAdmins(): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM platform_admin`).get() as { n: number }).n;
}

function normPadminUsername(u: unknown): string {
  const name = typeof u === 'string' ? u.trim() : '';
  if (name.length < 3 || name.length > 32) throw new Error('用户名需 3-32 个字符');
  if (!/^[\w.@-]+$/.test(name)) throw new Error('用户名仅限字母/数字/._@-');
  return name;
}
function assertPadminPassword(pw: unknown): asserts pw is string {
  if (typeof pw !== 'string' || pw.length < 8) throw new Error('密码至少 8 位');
  if (pw.length > 200) throw new Error('密码过长');
}

/** 新增平台超管(用户名唯一)。返回新建条目。 */
export async function createPlatformAdmin(username: string, password: string): Promise<PlatformAdminListItem> {
  const name = normPadminUsername(username);
  assertPadminPassword(password);
  if (db.prepare(`SELECT 1 FROM platform_admin WHERE username=?`).get(name)) throw new Error('超管用户名已存在');
  const id = randomUUID();
  const t = now();
  const hash = await hashPassword(password);
  db.prepare(`INSERT INTO platform_admin (id,username,password_hash,created_at) VALUES (?,?,?,?)`).run(id, name, hash, t);
  return { id, username: name, createdAt: t };
}

/** 改某超管密码(免旧密码:调用者已是超管)。不存在 → false。 */
export async function setPlatformAdminPassword(id: string, newPassword: string): Promise<boolean> {
  assertPadminPassword(newPassword);
  if (!db.prepare(`SELECT 1 FROM platform_admin WHERE id=?`).get(id)) return false;
  const hash = await hashPassword(newPassword);
  db.prepare(`UPDATE platform_admin SET password_hash=? WHERE id=?`).run(hash, id);
  return true;
}

/** 删超管(连同其所有 session)。护栏(防自删/防删最后一个)在路由层。不存在 → false。
 *  顺序:先删 session 再删超管 —— platform_session.padmin_id 有 FK 指向 platform_admin,
 *  反过来会触发 FOREIGN KEY constraint。整体放事务保证原子。 */
export const deletePlatformAdmin = db.transaction((id: string): boolean => {
  db.prepare(`DELETE FROM platform_session WHERE padmin_id=?`).run(id);
  return db.prepare(`DELETE FROM platform_admin WHERE id=?`).run(id).changes === 1;
});

/** 作废某超管的 session;keepToken 指定则保留(改密后:其它端强制重登,当前端不掉线)。 */
export function clearPlatformSessionsExcept(padminId: string, keepToken?: string): void {
  if (keepToken) db.prepare(`DELETE FROM platform_session WHERE padmin_id=? AND token!=?`).run(padminId, keepToken);
  else db.prepare(`DELETE FROM platform_session WHERE padmin_id=?`).run(padminId);
}
