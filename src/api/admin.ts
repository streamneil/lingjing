// 灵镜 API — 平台超管后台(/admin)。
//
// 决策来源:/plan-ceo-review D1/D3/D4/D10/D11 + /plan-eng-review E-1.1/E-1.2/E-3.1。
//
// 隔离(E-1.1):本 Router 由 server.ts 挂在全局 attachUser 之前,且自身不挂 attachUser。
//   故 req.user 在 /admin 链路永远 undefined —— 租户拿 lj_session 打 /admin/* 也只会 401
//   (requirePlatformAdmin 只认 lj_padmin)。结构隔离,不靠"绝不读 req.user"口头承诺。
//
// 页面托管(E-1.2):admin 页由本 Router 用 sendFile 提供于 /admin/ 与 /admin/login,
//   使 Path=/admin 的 lj_padmin cookie 随 fetch 正确携带;HTML 放 prototype/admin/ 子目录,
//   server.ts 的全局 express.static 不托管它,避免顶层 /admin.html 暴露入口。
//
// 充值(D3):跨租户充值收归超管(POST /admin/api/tenants/:id/grant);租户自助充值
//   (旧 POST /api/credits/grant)已删除,堵 SaaS 收入洞。

import { Router, type Request, type Response } from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { db, type TenantRow } from '../db/index.js';
import { createTenant, createUser } from '../auth/index.js';
import { grant, balance } from '../credits/index.js';
import { writePlatformAudit, PLATFORM_TENANT } from '../audit/index.js';
import {
  platformLogin,
  platformLogout,
  setPadminCookie,
  clearPadminCookie,
  readPadminToken,
  requirePlatformAdmin,
  consumeCaptchaToken,
} from '../auth/platform.js';
import type { Role } from '../db/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminPagesDir = resolve(__dirname, '..', '..', 'prototype', 'admin');

export const adminRouter = Router();

function padminIp(req: Request): string | null {
  return req.socket?.remoteAddress ?? null;
}

// ── 页面(sendFile 提供于 /admin 前缀,使 lj_padmin cookie 随 fetch 携带)──
adminRouter.get('/', (_req, res) => res.sendFile(resolve(adminPagesDir, 'admin.html')));
adminRouter.get('/login', (_req, res) => res.sendFile(resolve(adminPagesDir, 'admin-login.html')));

// ── 超管登录 / 登出(防暴破:必携 captcha_token)──
adminRouter.post('/login', (req: Request, res: Response) => {
  const { username, password, captchaToken } = req.body ?? {};
  if (!username || !password) return res.status(400).json({ error: '缺少 username / password' });
  if (!consumeCaptchaToken(captchaToken)) {
    return res.status(400).json({ error: '请先完成滑块验证' });
  }
  try {
    const token = platformLogin(username, password);
    setPadminCookie(res, token);
    const padmin = req.body.username as string;
    writePlatformAudit(padmin, 'padmin_login', PLATFORM_TENANT, username, padminIp(req));
    return res.json({ ok: true });
  } catch (e) {
    return res.status(401).json({ error: e instanceof Error ? e.message : '登录失败' });
  }
});

adminRouter.post('/logout', requirePlatformAdmin, (req: Request, res: Response) => {
  const token = readPadminToken(req);
  if (token) platformLogout(token);
  clearPadminCookie(res);
  return res.json({ ok: true });
});

// 当前超管(前端判断登录态)
adminRouter.get('/api/me', requirePlatformAdmin, (req: Request, res: Response) => {
  return res.json(req.padmin);
});

// ── 租户管理 ──
interface TenantListItem extends TenantRow {
  balance: number;
  user_count: number;
}

adminRouter.get('/api/tenants', requirePlatformAdmin, (_req: Request, res: Response) => {
  const tenants = db
    .prepare(`SELECT * FROM tenant ORDER BY created_at DESC`)
    .all() as TenantRow[];
  // 每租户附余额 + 用户数(供后台总览)。租户量级小(几十~几百),低频后台查询,不优化。
  const items: TenantListItem[] = tenants.map((t) => {
    const uc = (db.prepare(`SELECT COUNT(*) AS n FROM user WHERE tenant_id=?`).get(t.id) as { n: number }).n;
    return { ...t, balance: balance(t.id), user_count: uc };
  });
  return res.json({ tenants: items });
});

adminRouter.post('/api/tenants', requirePlatformAdmin, (req: Request, res: Response) => {
  const { name, delivery } = req.body ?? {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: '机构名称不能为空' });
  }
  const dlv = delivery === 'private' ? 'private' : 'hosted';
  const t = createTenant(name.trim(), dlv);
  writePlatformAudit(req.padmin!.id, 'tenant_create', t.id, `${t.name}(${dlv})`, padminIp(req));
  return res.status(201).json({ id: t.id, name: t.name, delivery: t.delivery });
});

// ── 开户(复用 createUser,透传 code 到 UI — E2)──
adminRouter.post('/api/tenants/:id/users', requirePlatformAdmin, (req: Request, res: Response) => {
  const tenantId = req.params.id!;
  const { username, password, role } = req.body ?? {};
  if (!username || !password || !role) {
    return res.status(400).json({ error: '缺少 username / password / role' });
  }
  // 校验租户存在(避免给孤儿租户开户)
  if (!db.prepare(`SELECT 1 FROM tenant WHERE id=?`).get(tenantId)) {
    return res.status(404).json({ error: '租户不存在' });
  }
  try {
    const u = createUser(tenantId, username, password, role as Role);
    writePlatformAudit(req.padmin!.id, 'tenant_user_create', tenantId, `${u.username}(${u.role})`, padminIp(req));
    return res.status(201).json({ id: u.id, username: u.username, role: u.role });
  } catch (e) {
    // createUser 抛 code(SEATS_FULL/INVALID_ROLE)或保留字/重名错,透传给 UI(E2)
    const code = (e as { code?: string })?.code;
    const error = e instanceof Error ? e.message : '开户失败';
    return res.status(409).json({ error, ...(code ? { code } : {}) });
  }
});

// ── 跨租户充值(E1:先校验 tenant 存在,不存在 404,防孤儿 ledger)──
adminRouter.post('/api/tenants/:id/grant', requirePlatformAdmin, (req: Request, res: Response) => {
  const tenantId = req.params.id!;
  const { amount, note } = req.body ?? {};
  if (typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ error: 'amount 必须为正数' });
  }
  if (!db.prepare(`SELECT 1 FROM tenant WHERE id=?`).get(tenantId)) {
    return res.status(404).json({ error: '租户不存在' });
  }
  grant(tenantId, amount, note || '平台充值');
  // 记目标租户:租户 admin 能在自己审计看到"平台于 X 时充值 N"(D11/C1)
  writePlatformAudit(req.padmin!.id, 'grant_credit', tenantId, `+${amount}`, padminIp(req));
  return res.json({ ok: true, balance: balance(tenantId) });
});
