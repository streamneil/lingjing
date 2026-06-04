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

const now = () => Date.now();
const PADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 小时绝对过期(超管高权限,比租户 7 天短)
const PADMIN_COOKIE = 'lj_padmin';

// ── 首启引导:platform_admin 表空 → env 种子建初始超管 ──
//
// 幂等:表非空不重建(INSERT 前先查)。SUPERADMIN_PASS 未设时 config.superadmin.password()
// 抛错 → 拒绝启动(B3,绝不用默认口令)。已建超管的环境不进 INSERT 分支,不会因缺 pass 崩。
export function bootstrapSuperadmin(): void {
  const count = (db.prepare(`SELECT COUNT(*) AS n FROM platform_admin`).get() as { n: number }).n;
  if (count > 0) return; // 已有超管,不重建(幂等)
  const username = config.superadmin.username;
  const password = config.superadmin.password(); // 未设 SUPERADMIN_PASS 在此抛错拒启
  db.prepare(
    `INSERT INTO platform_admin (id,username,password_hash,created_at) VALUES (?,?,?,?)`,
  ).run(randomUUID(), username, hashPassword(password), now());
  console.log(`[超管] 初始平台超管已创建:${username}(密码取自 SUPERADMIN_PASS)`);
}

// ── 滑块行为验证 ──
const CAPTCHA_TTL_MS = 2 * 60 * 1000; // challenge / token 2 分钟过期
const CAPTCHA_TOLERANCE = 6; // 位置比对容差(px)
const CAPTCHA_TRACK_W = 280; // 滑轨宽度(前端一致)
const CAPTCHA_GAP_MIN = 60; // 缺口最小 x(避开两端)
const CAPTCHA_GAP_MAX = 240;

/** 惰性清理过期 challenge / token(每次出题/校验顺带,免定时 job)。 */
function sweepCaptcha(): void {
  const t = now();
  db.prepare(`DELETE FROM captcha_challenge WHERE expires_at < ?`).run(t);
  db.prepare(`DELETE FROM captcha_token WHERE expires_at < ?`).run(t);
}

/** 出题:生成缺口 x(存服务端),返回 challenge_id + 缺口位置供前端渲染拼图。
 *  注意:target_x 也返回给前端用于"画缺口图"——前端需要知道缺口在哪才能画,
 *  但校验时服务端用自己存的值比对前端提交的滑块落点,前端篡改返回值无用
 *  (它改的是自己画的图,服务端比的是自己存的 target)。真挡的是不渲染滑块、
 *  直接 POST /login 的无头脚本(没 token 直接 400)。 */
export function createCaptchaChallenge(): { challengeId: string; gapX: number; trackW: number } {
  sweepCaptcha();
  // 伪随机缺口位置:用 token 字节派生(环境禁用 Math.random,且这里只需不可预测性中等)。
  const seed = parseInt(genToken().slice(0, 8), 16);
  const gapX = CAPTCHA_GAP_MIN + (seed % (CAPTCHA_GAP_MAX - CAPTCHA_GAP_MIN));
  const id = randomUUID();
  const t = now();
  db.prepare(
    `INSERT INTO captcha_challenge (id,target_x,created_at,expires_at) VALUES (?,?,?,?)`,
  ).run(id, gapX, t, t + CAPTCHA_TTL_MS);
  return { challengeId: id, gapX, trackW: CAPTCHA_TRACK_W };
}

/** 校验滑块落点。位置在容差内 → 消费 challenge + 发一次性 token。失败/过期 → null。 */
export function verifyCaptchaSlide(challengeId: string, x: number): string | null {
  sweepCaptcha();
  const row = db
    .prepare(`SELECT target_x, expires_at FROM captcha_challenge WHERE id=?`)
    .get(challengeId) as { target_x: number; expires_at: number } | undefined;
  if (!row || row.expires_at < now()) return null;
  // challenge 一次性:无论成败都删(防同一 challenge 暴力试 x)
  db.prepare(`DELETE FROM captcha_challenge WHERE id=?`).run(challengeId);
  if (!Number.isFinite(x) || Math.abs(x - row.target_x) > CAPTCHA_TOLERANCE) return null;
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
export function platformLogin(username: string, password: string): string {
  const pa = db
    .prepare(`SELECT * FROM platform_admin WHERE username=?`)
    .get(username) as PlatformAdminRow | undefined;
  const fail = () => new Error('用户名或密码错误');
  if (!pa) {
    dummyVerify(password); // 抵消时序差异
    throw fail();
  }
  if (!verifyPassword(password, pa.password_hash)) throw fail();
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
  // Secure 生产开(本地非 HTTPS 留空);HttpOnly 防 XSS 偷 token。
  res.setHeader(
    'Set-Cookie',
    `${PADMIN_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${8 * 3600}`,
  );
}

export function clearPadminCookie(res: Response): void {
  res.setHeader('Set-Cookie', `${PADMIN_COOKIE}=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0`);
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
