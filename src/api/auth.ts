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
  changeRole,
  listUsers,
  seatUsage,
  updateDisplayName,
  changePassword,
  tenantAdminResetPassword,
  loginOrRegisterByPhone,
} from '../auth/index.js';
import { sendSmsCode, normalizePhone, assertVerifyAllowed, RateLimitError } from '../auth/sms.js';
import { SmsSendError } from '../sms/sender.js';
import {
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  requireRole,
} from '../auth/middleware.js';
import { audit, writeAudit } from '../audit/index.js';
import { resolveSession } from '../auth/index.js';
import { consumeCaptchaToken } from '../auth/platform.js';
import type { Role } from '../db/index.js';

export const authRouter = Router();

// 登录:(username, password) → 设 session cookie(用户名全局唯一,租户从账号反查)。
// 防暴破(D8/D9):必携 captcha_token(滑块过后服务端发的一次性凭证),消费即弃。
authRouter.post('/login', async (req: Request, res: Response) => {
  const { username, password, captchaToken } = req.body ?? {};
  if (!username || !password) {
    return res.status(400).json({ error: '缺少 username / password' });
  }
  if (!consumeCaptchaToken(captchaToken)) {
    return res.status(400).json({ error: '请先完成滑块验证' });
  }
  try {
    const token = await login(username, password);
    setSessionCookie(res, token);
    // 审计登录(此时 req.user 还没挂,用 resolveSession 拿 user id)
    const u = resolveSession(token);
    if (u) writeAudit(u.tenantId, u.id, 'login', null, req.socket?.remoteAddress ?? null);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(401).json({ error: e instanceof Error ? e.message : '登录失败' });
  }
});

// 发验证码:phone 先校验(不浪费滑块)→ 消费 captcha_token → 限频 + 发短信。
// 失败分类:429 限频(带 retryAfter 供倒计时)/ 502 短信服务(config 错误大声记日志)/ 400 参数。
authRouter.post('/sms/send', async (req: Request, res: Response) => {
  const { phone: rawPhone, captchaToken } = req.body ?? {};
  let phone: string;
  try { phone = normalizePhone(rawPhone); } catch (e) { return res.status(400).json({ error: e instanceof Error ? e.message : '手机号无效' }); }
  if (!consumeCaptchaToken(captchaToken)) return res.status(400).json({ error: '请先完成滑块验证' });
  const ip = req.socket?.remoteAddress ?? null;
  try {
    await sendSmsCode(phone, 'login', ip);
    return res.json({ ok: true });
  } catch (e) {
    if (e instanceof RateLimitError) {
      return res.status(429).json({ error: e.message, code: e.code, retryAfter: e.retryAfterSec });
    }
    if (e instanceof SmsSendError) {
      // 配置错(签名/模板/AK)用户看不出但运维须知 —— 大声记日志告警。
      if (e.kind === 'config') console.error('[短信·配置错误] 检查阿里云签名/模板/AccessKey:', e.providerCode, e.message);
      const msg = e.kind === 'transient' ? '发送过于频繁,请稍后再试'
        : e.kind === 'rejected' ? '该手机号无法接收短信' : '短信服务异常,请稍后再试';
      return res.status(502).json({ error: msg });
    }
    console.error('[短信·send 未知错误]', e);
    return res.status(500).json({ error: '发送失败,请稍后再试' });
  }
});

// 验证码登录/注册(统一入口):验码闸 → loginOrRegisterByPhone(老号登录/新号建机构)。
// captcha 在发码时已过;此处只验码,故无需再 captcha。验失败上限走 assertVerifyAllowed(防穷举)。
authRouter.post('/sms/login', (req: Request, res: Response) => {
  const { phone: rawPhone, code } = req.body ?? {};
  let phone: string;
  try { phone = normalizePhone(rawPhone); } catch (e) { return res.status(400).json({ error: e instanceof Error ? e.message : '手机号无效' }); }
  if (!code || typeof code !== 'string') return res.status(400).json({ error: '请输入验证码' });
  const ip = req.socket?.remoteAddress ?? null;
  try { assertVerifyAllowed(ip); } catch (e) {
    if (e instanceof RateLimitError) return res.status(429).json({ error: e.message, code: e.code });
    throw e;
  }
  const r = loginOrRegisterByPhone(phone, code.trim(), ip);
  if (!r.ok) return res.status(400).json({ error: r.error });
  setSessionCookie(res, r.token);
  writeAudit(r.tenantId, r.userId, r.isNew ? 'register_self_serve' : 'login_sms', null, ip);
  return res.json({ ok: true, isNew: r.isNew });
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

// 改个人信息(昵称)
authRouter.put('/me', requireAuth, (req: Request, res: Response) => {
  const displayName = (req.body?.displayName as string || '').trim();
  if (!displayName) return res.status(400).json({ error: '昵称不能为空' });
  if (displayName.length > 30) return res.status(400).json({ error: '昵称过长(≤30 字)' });
  updateDisplayName(req.user!.id, displayName);
  audit(req, 'update_profile', displayName);
  return res.json({ ok: true, displayName });
});

// 改密码(校验原密码;成功后作废其它会话,当前会话保留)
authRouter.post('/me/password', requireAuth, async (req: Request, res: Response) => {
  const { oldPassword, newPassword } = req.body ?? {};
  if (!oldPassword || !newPassword) return res.status(400).json({ error: '缺少原密码 / 新密码' });
  try {
    // 当前 session token 从 cookie 取,改密后保留它(不把自己踢下线)
    const m = (req.headers.cookie ?? '').match(/lj_session=([^;]+)/);
    const keep = m ? decodeURIComponent(m[1]!) : undefined;
    await changePassword(req.user!.id, oldPassword, newPassword, keep);
    audit(req, 'change_password');
    return res.json({ ok: true });
  } catch (e) {
    return res.status(400).json({ error: e instanceof Error ? e.message : '改密码失败' });
  }
});

// ── 成员管理(仅 admin)──
//
// 业务错误带 code(SEATS_FULL/LAST_ADMIN/SELF_ACTION/INVALID_ROLE)→ 409 + {error,code};
// 前端按 code 分支(席位满弹窗内联 / 其余 toast),不 string-match 中文文案。
function memberError(res: Response, e: unknown): Response {
  const code = (e as { code?: string })?.code;
  const error = e instanceof Error ? e.message : '操作失败';
  if (code) return res.status(409).json({ error, code });
  return res.status(409).json({ error });
}

// 成员名单只读:登录即可看(团队透明);写操作仍 admin-only(下方各路由)。
// 非 admin 看得到名单/角色/状态,但前端按钮灰禁 + 后端写路由 403 双保险。
authRouter.get('/members', requireAuth, (req: Request, res: Response) => {
  const tid = req.user!.tenantId;
  // 附带席位用量供统计卡(已用 = 持席位 creator 数,上限 = max_creator_seats)。
  return res.json({ members: listUsers(tid), seats: seatUsage(tid) });
});

authRouter.post('/members', requireRole('admin'), async (req: Request, res: Response) => {
  const { username, password, role, displayName } = req.body ?? {};
  if (!username || !password || !role) {
    return res.status(400).json({ error: '缺少 username / password / role' });
  }
  try {
    const u = await createUser(
      req.user!.tenantId,
      username,
      password,
      role as Role,
      typeof displayName === 'string' ? displayName : undefined,
    );
    audit(req, 'member_add', `${u.display_name}(${u.username}/${u.role})`);
    return res.status(201).json({ id: u.id, username: u.username, displayName: u.display_name, role: u.role });
  } catch (e) {
    return memberError(res, e);
  }
});

// 管理员强制重置成员密码:随机生成 → 作废其 session → 返回 {username, password}(明文仅此次回传)。
// 自我保护:不能重置自己(auth/index.ts 抛 CANNOT_RESET_SELF)。审计仅记动作,不含密码明文。
authRouter.post('/members/:id/reset-password', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const r = await tenantAdminResetPassword(req.user!.tenantId, req.params.id!, req.user!.id);
    if (!r) return res.status(404).json({ error: '成员不存在' });
    audit(req, 'member_reset_pw', r.username);
    return res.json({ ok: true, username: r.username, password: r.password });
  } catch (e) {
    return memberError(res, e);
  }
});

authRouter.post('/members/:id/disable', requireRole('admin'), (req: Request, res: Response) => {
  try {
    const ok = setUserStatus(req.user!.tenantId, req.params.id!, 'disabled', req.user!.id);
    return ok ? res.json({ ok: true }) : res.status(404).json({ error: '成员不存在' });
  } catch (e) {
    return memberError(res, e);
  }
});

authRouter.post('/members/:id/enable', requireRole('admin'), (req: Request, res: Response) => {
  try {
    const ok = setUserStatus(req.user!.tenantId, req.params.id!, 'active', req.user!.id);
    return ok ? res.json({ ok: true }) : res.status(404).json({ error: '成员不存在' });
  } catch (e) {
    return memberError(res, e);
  }
});

authRouter.delete('/members/:id', requireRole('admin'), (req: Request, res: Response) => {
  try {
    const ok = removeUser(req.user!.tenantId, req.params.id!, req.user!.id);
    return ok ? res.json({ ok: true }) : res.status(404).json({ error: '成员不存在' });
  } catch (e) {
    return memberError(res, e);
  }
});

// 改角色:闭合席位不变量漏洞(→creator 走席位校验,admin 降级走 last-admin 校验)。
authRouter.put('/members/:id/role', requireRole('admin'), (req: Request, res: Response) => {
  const { role } = req.body ?? {};
  if (!role) return res.status(400).json({ error: '缺少 role' });
  try {
    const ok = changeRole(req.user!.tenantId, req.params.id!, role as Role, req.user!.id);
    if (!ok) return res.status(404).json({ error: '成员不存在' });
    audit(req, 'member_role', `${req.params.id}→${role}`);
    return res.json({ ok: true });
  } catch (e) {
    return memberError(res, e);
  }
});
