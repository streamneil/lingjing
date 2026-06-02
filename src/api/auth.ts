// 灵镜 API — 认证 + 成员管理路由。
//
// /plan-eng-review 验收第8条:三角色权限隔离。成员管理仅 admin。

import { Router, type Request, type Response } from 'express';
import {
  login,
  logout,
  createUser,
  setUserStatus,
  removeUser,
  listUsers,
} from '../auth/index.js';
import {
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  requireRole,
} from '../auth/middleware.js';
import { audit, writeAudit } from '../audit/index.js';
import { resolveSession } from '../auth/index.js';
import type { Role } from '../db/index.js';

export const authRouter = Router();

// 登录:(tenantId, username, password) → 设 session cookie
authRouter.post('/login', (req: Request, res: Response) => {
  const { tenantId, username, password } = req.body ?? {};
  if (!tenantId || !username || !password) {
    return res.status(400).json({ error: '缺少 tenantId / username / password' });
  }
  try {
    const token = login(tenantId, username, password);
    setSessionCookie(res, token);
    // 审计登录(此时 req.user 还没挂,用 resolveSession 拿 user id)
    const u = resolveSession(token);
    if (u) writeAudit(u.tenantId, u.id, 'login', null, req.socket?.remoteAddress ?? null);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(401).json({ error: e instanceof Error ? e.message : '登录失败' });
  }
});

authRouter.post('/logout', requireAuth, (req: Request, res: Response) => {
  // token 在 cookie 里;middleware 已校验。直接清 cookie + 删 session。
  const raw = req.headers.cookie ?? '';
  const m = raw.match(/lj_session=([^;]+)/);
  if (m) logout(decodeURIComponent(m[1]!));
  clearSessionCookie(res);
  return res.json({ ok: true });
});

// 当前用户(前端判断登录态/角色)
authRouter.get('/me', requireAuth, (req: Request, res: Response) => {
  return res.json(req.user);
});

// ── 成员管理(仅 admin)──
authRouter.get('/members', requireRole('admin'), (req: Request, res: Response) => {
  return res.json(listUsers(req.user!.tenantId));
});

authRouter.post('/members', requireRole('admin'), (req: Request, res: Response) => {
  const { username, password, role } = req.body ?? {};
  if (!username || !password || !role) {
    return res.status(400).json({ error: '缺少 username / password / role' });
  }
  if (!['admin', 'creator', 'viewer'].includes(role)) {
    return res.status(400).json({ error: '角色非法' });
  }
  try {
    const u = createUser(req.user!.tenantId, username, password, role as Role);
    audit(req, 'member_add', `${u.username}(${u.role})`);
    return res.status(201).json({ id: u.id, username: u.username, role: u.role });
  } catch (e) {
    return res.status(409).json({ error: e instanceof Error ? e.message : '创建失败' });
  }
});

authRouter.post('/members/:id/disable', requireRole('admin'), (req: Request, res: Response) => {
  const ok = setUserStatus(req.user!.tenantId, req.params.id!, 'disabled');
  return ok ? res.json({ ok: true }) : res.status(404).json({ error: '成员不存在' });
});

authRouter.post('/members/:id/enable', requireRole('admin'), (req: Request, res: Response) => {
  const ok = setUserStatus(req.user!.tenantId, req.params.id!, 'active');
  return ok ? res.json({ ok: true }) : res.status(404).json({ error: '成员不存在' });
});

authRouter.delete('/members/:id', requireRole('admin'), (req: Request, res: Response) => {
  const ok = removeUser(req.user!.tenantId, req.params.id!);
  return ok ? res.json({ ok: true }) : res.status(404).json({ error: '成员不存在' });
});
