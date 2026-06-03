// 灵镜 RBAC 中间件 — 从 cookie 取 session,挂当前用户,按角色拦截。
//
// 决策来源:/plan-eng-review 验收第8条 —— 三角色权限隔离:
//   查看者(viewer):只读作品、下载
//   创作者(creator):形象/音色/素材/作品的创建与使用(可发起生成),但不能管成员
//   管理员(admin):成员管理、用量、配置
//
// 权限矩阵(谁能做什么):
//   ┌────────────┬───────┬─────────┬───────┐
//   │ 动作        │ admin │ creator │ viewer│
//   ├────────────┼───────┼─────────┼───────┤
//   │ 发起生成    │  ✓    │   ✓     │   ✗   │
//   │ 看/下载作品 │  ✓    │   ✓     │   ✓   │
//   │ 管理成员    │  ✓    │   ✗     │   ✗   │
//   └────────────┴───────┴─────────┴───────┘

import type { Request, Response, NextFunction } from 'express';
import { resolveSession, type AuthedUser } from './index.js';

// 把当前用户挂到 req 上(扩展 Express 类型)
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthedUser;
    }
  }
}

const COOKIE_NAME = 'lj_session';

/** 极简 cookie 解析(不引 cookie-parser,少一个依赖)。 */
function readSessionCookie(req: Request): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE_NAME) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export function setSessionCookie(res: Response, token: string): void {
  // HttpOnly 防 XSS 偷 token;SameSite=Lax 防基础 CSRF。Slice1 本地非 HTTPS,Secure 留给生产。
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 24 * 3600}`,
  );
}

export function clearSessionCookie(res: Response): void {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

/** 解析 session 并挂 req.user(不强制登录,后续中间件决定)。 */
export function attachUser(req: Request, _res: Response, next: NextFunction): void {
  const user = resolveSession(readSessionCookie(req));
  if (user) req.user = user;
  next();
}

/** 要求已登录。 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: '未登录' });
    return;
  }
  next();
}

/** 要求具备指定角色之一。 */
export function requireRole(...roles: AuthedUser['role'][]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: '未登录' });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: '权限不足', need: roles, have: req.user.role });
      return;
    }
    next();
  };
}
