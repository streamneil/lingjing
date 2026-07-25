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
import { resolveApiKeyFull } from './api-keys.js';
import { SlidingWindowLimiter } from './rate-limit.js';
import { secureAttr } from './cookie.js';

// 把当前用户挂到 req 上(扩展 Express 类型)
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthedUser;
      viaApiKey?: boolean; // 经 Open API key 认证(非 cookie session):作用域受限,见 requireApiScope
      apiKeyId?: string; // 命中的 api_key.id(限速计数 + 审计 via_api_key 标记用)
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
  // HttpOnly 防 XSS 偷 token;SameSite=Lax 防基础 CSRF;Secure 由 COOKIE_SECURE env 控(生产 HTTPS 带)。
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/${secureAttr()}; Max-Age=${7 * 24 * 3600}`,
  );
}

export function clearSessionCookie(res: Response): void {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/${secureAttr()}; Max-Age=0`);
}

/** 解析 session 并挂 req.user(不强制登录,后续中间件决定)。
 *  cookie 未命中时回落 Open API key(Authorization: Bearer lj_sk_…),并标 req.viaApiKey。
 *  key == 成员本人:构造与 session 逐字段一致的 AuthedUser,后续 requireRole/积分/审核零改动。 */
export function attachUser(req: Request, _res: Response, next: NextFunction): void {
  const user = resolveSession(readSessionCookie(req));
  if (user) {
    req.user = user;
    return next();
  }
  const viaKey = resolveApiKeyFull(req.headers.authorization);
  if (viaKey) {
    req.user = viaKey.user;
    req.viaApiKey = true;
    req.apiKeyId = viaKey.keyId;
  }
  next();
}

// ── Open API key 限速(设计文档 §4.3,D9 读写分级)──
// 单进程内存滑窗,每 key 计数。写(提交/上传)易烧积分,严;读(查询/列表)Agent 需高频轮询,宽。
// 上限可经 env 覆盖(测试用小值);默认 写 60/min、读 300/min。
const WRITE_PER_MIN = Number(process.env.API_RATE_WRITE_PER_MIN) || 60;
const READ_PER_MIN = Number(process.env.API_RATE_READ_PER_MIN) || 300;
const writeLimiter = new SlidingWindowLimiter(60_000, WRITE_PER_MIN);
const readLimiter = new SlidingWindowLimiter(60_000, READ_PER_MIN);
// 惰性回收:每分钟 sweep 一次空 key(unref 不阻塞进程退出)。
const _sweep = setInterval(() => { writeLimiter.sweep(); readLimiter.sweep(); }, 60_000);
if (typeof _sweep.unref === 'function') _sweep.unref();

/** API key 限速守卫:仅约束 viaApiKey 流量,读写分级。超限 → 429 RATE_LIMITED。 */
export function apiRateLimit(req: Request, res: Response, next: NextFunction): void {
  if (!req.viaApiKey || !req.apiKeyId) return next(); // 只约束 API key 流量
  const limiter = req.method === 'GET' ? readLimiter : writeLimiter;
  if (limiter.allow(req.apiKeyId)) return next();
  res.status(429).json({ error: '请求过于频繁,请稍后重试', code: 'RATE_LIMITED' });
}

// ── Open API key 作用域白名单(设计文档 §4.2)──
// key 只放行生成面;settings/members/payments/orders 等一律 403,防 key 泄漏后改配置/看账单。
// 匹配 req.path(已含 /api 前缀,因守卫全局挂在 attachUser 之后、路由之前)。
const API_SCOPE_ALLOW: RegExp[] = [
  /^\/api\/jobs(\/|$)/, // 提交/查询/下载/重试/估价
  /^\/api\/[a-z0-9-]*-models(\/|$)/, // image/tts/video/i2v/r2v/edit 模型列表(-models 结尾)
  /^\/api\/(image|video|audio)-uploads(\/|$)/, // 参考素材上传(consent 照旧强制)
  /^\/api\/credits\/balance(\/|$)/, // 查余额(Agent 需要)
];
// 只读放行:发现音色/形象 ID(否则 TTS/数字人链路 API 死路,外部声音 #1)。仅 GET。
const API_SCOPE_ALLOW_GET: RegExp[] = [
  /^\/api\/voices(\/|$)/,
  /^\/api\/avatars(\/|$)/,
];

// 403 里回给调用方的可用端点清单。守卫全局挂在路由**之前**,故不存在的路径也照样 403(不会走到 404)——
// 只回「无权访问」会让 Agent 把「路径写错」误判成「密钥 scope 不够」,进而去找人要权限而不是改调用
// (v0.8.0.7 真实事故:Agent 想传图生图参考图,撞 403 后报「key 只开了 MCP」,实则 image-uploads 一直是放行的)。
// 故把白名单直接回给它:能自我纠正的错误,才是对 Agent 有用的错误。
const API_SCOPE_HINT = [
  'POST /api/jobs(提交生成)· GET /api/jobs/{id}(查结果)',
  'POST /api/image-uploads · /api/video-uploads · /api/audio-uploads(上传参考素材,multipart,需 consent=true)',
  'GET /api/image-models · /api/video-models 等(模型列表)',
  'GET /api/voices · /api/avatars(只读:音色/形象发现;形象需在灵镜后台创建)',
  'GET /api/credits/balance(查余额)',
];

/** Open API key 作用域守卫:viaApiKey 请求只放行生成面,其余 /api/* → 403。
 *  非 key 请求(cookie session / 公开接口)完全不受影响。 */
export function requireApiScope(req: Request, res: Response, next: NextFunction): void {
  if (!req.viaApiKey) return next(); // 只约束 API key 流量
  const p = req.path;
  if (API_SCOPE_ALLOW.some((re) => re.test(p))) return next();
  if (req.method === 'GET' && API_SCOPE_ALLOW_GET.some((re) => re.test(p))) return next();
  res.status(403).json({
    error: `API 密钥无权访问此接口(${req.method} ${p})。注意:不存在的路径也会返回本错误,请先核对下方可用端点清单。`,
    code: 'SCOPE_FORBIDDEN',
    allowed: API_SCOPE_HINT,
  });
}

/** 要求已登录。 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: '未登录', code: 'UNAUTHORIZED' });
    return;
  }
  next();
}

/** 要求具备指定角色之一。 */
export function requireRole(...roles: AuthedUser['role'][]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: '未登录', code: 'UNAUTHORIZED' });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: '权限不足', code: 'ROLE_FORBIDDEN', need: roles, have: req.user.role });
      return;
    }
    next();
  };
}
