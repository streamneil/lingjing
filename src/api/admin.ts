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
import {
  createTenant,
  createUser,
  listUsers,
  updateTenant,
  adminResetPassword,
  setUserStatus,
} from '../auth/index.js';
import { grant, balance } from '../credits/index.js';
import { IMAGE_MODELS } from '../gateway/image-models.js';
import type { ImageModelOverrideRow } from '../db/index.js';
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
  const { name } = req.body ?? {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: '机构名称不能为空' });
  }
  // 新建租户固定 hosted:私有化是独立部署交付,不在 SaaS 超管这里管(A1)。
  // 若需把某租户标为私有化,走租户详情的"改交付模式"(PUT /api/tenants/:id)。
  const t = createTenant(name.trim(), 'hosted');
  writePlatformAudit(req.padmin!.id, 'tenant_create', t.id, t.name, padminIp(req));
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

// ── 租户详情管理 ──
// 小工具:校验租户存在,不存在直接 404 写响应并返回 false。
function ensureTenant(tenantId: string, res: Response): boolean {
  if (!db.prepare(`SELECT 1 FROM tenant WHERE id=?`).get(tenantId)) {
    res.status(404).json({ error: '租户不存在' });
    return false;
  }
  return true;
}

// 改租户配置(机构名 / 席位上限 / 交付模式)。租户侧机构名只读,只有超管能改。
adminRouter.put('/api/tenants/:id', requirePlatformAdmin, (req: Request, res: Response) => {
  const tenantId = req.params.id!;
  if (!ensureTenant(tenantId, res)) return;
  const { name, maxCreatorSeats, delivery } = req.body ?? {};
  try {
    const ok = updateTenant(tenantId, { name, maxCreatorSeats, delivery });
    if (!ok) return res.status(404).json({ error: '租户不存在' });
    const changed = [
      name !== undefined ? `名称→${name}` : null,
      maxCreatorSeats !== undefined ? `席位→${maxCreatorSeats}` : null,
      delivery !== undefined ? `交付→${delivery}` : null,
    ].filter(Boolean).join(' ');
    writePlatformAudit(req.padmin!.id, 'tenant_update', tenantId, changed || '无变更', padminIp(req));
    return res.json({ ok: true });
  } catch (e) {
    return res.status(400).json({ error: e instanceof Error ? e.message : '更新失败' });
  }
});

// 列租户下的用户(重置密码/停用启用的前提)。
adminRouter.get('/api/tenants/:id/users', requirePlatformAdmin, (req: Request, res: Response) => {
  const tenantId = req.params.id!;
  if (!ensureTenant(tenantId, res)) return;
  return res.json({ users: listUsers(tenantId) });
});

// 重置租户用户密码(免旧密码,运营帮租户找回;作废其所有 session 强制重登)。
adminRouter.post('/api/tenants/:id/users/:uid/reset-password', requirePlatformAdmin, (req: Request, res: Response) => {
  const tenantId = req.params.id!;
  const userId = req.params.uid!;
  if (!ensureTenant(tenantId, res)) return;
  const { newPassword } = req.body ?? {};
  try {
    const ok = adminResetPassword(tenantId, userId, newPassword);
    if (!ok) return res.status(404).json({ error: '用户不存在' });
    writePlatformAudit(req.padmin!.id, 'tenant_user_reset_pw', tenantId, userId, padminIp(req));
    return res.json({ ok: true });
  } catch (e) {
    return res.status(400).json({ error: e instanceof Error ? e.message : '重置失败' });
  }
});

// 停用 / 启用租户用户(复用 setUserStatus;超管操作不传 actingUserId,无自停保护需求)。
adminRouter.post('/api/tenants/:id/users/:uid/:action(disable|enable)', requirePlatformAdmin, (req: Request, res: Response) => {
  const tenantId = req.params.id!;
  const userId = req.params.uid!;
  const status = req.params.action === 'disable' ? 'disabled' : 'active';
  if (!ensureTenant(tenantId, res)) return;
  try {
    const ok = setUserStatus(tenantId, userId, status);
    if (!ok) return res.status(404).json({ error: '用户不存在' });
    writePlatformAudit(req.padmin!.id, `tenant_user_${req.params.action}`, tenantId, userId, padminIp(req));
    return res.json({ ok: true });
  } catch (e) {
    // setUserStatus 抛 LAST_ADMIN(停用最后一个 admin)等业务错
    const code = (e as { code?: string })?.code;
    return res.status(409).json({ error: e instanceof Error ? e.message : '操作失败', ...(code ? { code } : {}) });
  }
});

// ── AI 图片模型管理(CEO A2:代码拥有技术契约,DB 只覆盖展示/运营字段)──
// 管理视图 = 代码 IMAGE_MODELS(技术契约只读)+ DB override(label/modelId/enabled/price/maxImages 可改)。
// shape/sizeKind/modes/maxResolution 永不可编辑(防呆 by construction)。

const SHAPE_TEMPLATES = Object.keys(IMAGE_MODELS); // 合法 shape_template = 代码定义的 key

/** 列出所有模型(代码 key + DB 新增 key 的并集),含技术契约(只读)+ 当前生效值。 */
adminRouter.get('/api/image-models', requirePlatformAdmin, (_req: Request, res: Response) => {
  const rows = db
    .prepare('SELECT * FROM image_model_override')
    .all() as ImageModelOverrideRow[];
  const ovByKey = new Map(rows.map((r) => [r.key, r]));
  const keys = Array.from(new Set([...Object.keys(IMAGE_MODELS), ...rows.map((r) => r.key)]));
  const models = keys.map((key) => {
    const ov = ovByKey.get(key);
    const tmplKey = ov?.shape_template ?? key;
    const tmpl = IMAGE_MODELS[tmplKey];
    // 生效 modes:DB 勾选优先(用户选了「完全自由勾」),空回落代码模板。
    const ovModes = (ov?.modes ?? '').split(',').map((s) => s.trim()).filter((s) => s === 'text2img' || s === 'img2img');
    return {
      key,
      isCode: !!IMAGE_MODELS[key], // 代码内置(不可删)vs DB 新增(可删)
      // 生效值(DB 覆盖优先)
      label: ov?.label ?? tmpl?.label ?? key,
      modelId: ov?.model_id ?? tmpl?.modelId ?? '',
      enabled: ov ? ov.enabled === 1 : true,
      priceTier: ov?.price_tier ?? tmpl?.priceTier ?? 0,
      maxImages: ov?.max_images ?? tmpl?.maxImages ?? 1,
      shapeTemplate: tmplKey,
      modes: ovModes.length ? ovModes : (tmpl?.modes ?? []), // 生效 modes(管理员可改)
      templateModes: tmpl?.modes ?? [], // 代码模板「能力上限」(供 UI 提示:勾超出的可能生成失败)
      sortOrder: ov?.sort_order ?? 0,
      resolutions: parseAdminResolutions(ov?.resolutions), // admin 录的分辨率表(空数组=回落代码默认)
      // 技术契约(只读)
      shape: tmpl?.shape, sizeKind: tmpl?.sizeKind,
      maxResolution: tmpl?.maxResolution, maxInputImages: tmpl?.maxInputImages,
      hasOverride: !!ov,
    };
  });
  // 按 sortOrder 排(代码默认 0;同序按 key 稳定)
  models.sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key));
  res.json({ models, shapeTemplates: SHAPE_TEMPLATES });
});

// 解析 resolutions JSON 供 admin 视图(坏数据→空数组)。
function parseAdminResolutions(raw: string | null | undefined): { ratio: string; width: number; height: number; isDefault?: boolean }[] {
  if (!raw) return [];
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; } catch { return []; }
}

function validModelBody(b: Record<string, unknown>): { ok: true; v: { label: string; modelId: string; enabled: number; priceTier: number; maxImages: number; modes: string; sortOrder: number; resolutions: string | null } } | { ok: false; error: string } {
  const label = typeof b.label === 'string' ? b.label.trim() : '';
  const modelId = typeof b.modelId === 'string' ? b.modelId.trim() : '';
  if (!label) return { ok: false, error: '显示名不能为空' };
  if (!modelId) return { ok: false, error: '模型名(modelId)不能为空' };
  const priceTier = Number(b.priceTier);
  const maxImages = Number(b.maxImages);
  if (!Number.isFinite(priceTier) || priceTier <= 0) return { ok: false, error: '价格需为正数' };
  if (!Number.isInteger(maxImages) || maxImages < 1) return { ok: false, error: '张数上限需 ≥1' };
  const enabled = b.enabled === false || b.enabled === 0 ? 0 : 1;
  // modes:管理员勾选(完全自由),至少选一个;存 CSV。
  const modesArr = Array.isArray(b.modes) ? b.modes.filter((m) => m === 'text2img' || m === 'img2img') : [];
  if (modesArr.length === 0) return { ok: false, error: '请至少勾选一个模式(文生图/图生图)' };
  const sortOrder = Number.isFinite(Number(b.sortOrder)) ? Math.trunc(Number(b.sortOrder)) : 0;
  // resolutions:admin 录的分辨率表(可空)。每条 ratio/width/height 正整数;ratio 去重(P2-a)。
  let resolutions: string | null = null;
  if (Array.isArray(b.resolutions) && b.resolutions.length) {
    const seen = new Set<string>();
    const rows: { ratio: string; width: number; height: number; isDefault?: boolean }[] = [];
    for (const r of b.resolutions as Record<string, unknown>[]) {
      const ratio = typeof r?.ratio === 'string' ? r.ratio.trim() : '';
      const width = Number(r?.width);
      const height = Number(r?.height);
      if (!ratio) return { ok: false, error: '分辨率比例不能为空' };
      if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0)
        return { ok: false, error: `分辨率 ${ratio} 的宽高需为正整数` };
      if (seen.has(ratio)) return { ok: false, error: `分辨率比例 ${ratio} 重复` };
      seen.add(ratio);
      rows.push({ ratio, width, height, isDefault: r?.isDefault === true });
    }
    // 至多一个默认;无默认则首条
    if (rows.filter((x) => x.isDefault).length > 1) return { ok: false, error: '只能设一个默认分辨率' };
    if (!rows.some((x) => x.isDefault) && rows[0]) rows[0].isDefault = true;
    resolutions = JSON.stringify(rows);
  }
  return { ok: true, v: { label, modelId, enabled, priceTier, maxImages, modes: modesArr.join(','), sortOrder, resolutions } };
}

/** 新增模型(DB 新增 key,必须选一个代码 shape 模板,A5 防技术契约被破)。 */
adminRouter.post('/api/image-models', requirePlatformAdmin, (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const key = typeof b.key === 'string' ? b.key.trim() : '';
  const shapeTemplate = typeof b.shapeTemplate === 'string' ? b.shapeTemplate : '';
  if (!key || !/^[a-z0-9._-]+$/i.test(key)) return res.status(400).json({ error: 'key 仅限字母数字 . _ -' });
  if (IMAGE_MODELS[key] || db.prepare('SELECT 1 FROM image_model_override WHERE key=?').get(key))
    return res.status(409).json({ error: 'key 已存在' });
  if (!SHAPE_TEMPLATES.includes(shapeTemplate)) return res.status(400).json({ error: '无效 shape 模板' });
  const v = validModelBody(b);
  if (!v.ok) return res.status(400).json({ error: v.error });
  db.prepare(
    `INSERT INTO image_model_override (key,label,model_id,enabled,price_tier,max_images,shape_template,modes,sort_order,resolutions,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(key, v.v.label, v.v.modelId, v.v.enabled, v.v.priceTier, v.v.maxImages, shapeTemplate, v.v.modes, v.v.sortOrder, v.v.resolutions, Date.now());
  writePlatformAudit(req.padmin!.id, 'image_model_create', PLATFORM_TENANT, key, padminIp(req));
  res.status(201).json({ ok: true });
});

/** 改模型(代码内置 → upsert override;DB 新增 → update)。技术契约不可改。 */
adminRouter.put('/api/image-models/:key', requirePlatformAdmin, (req: Request, res: Response) => {
  const key = req.params.key!;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const codeDef = IMAGE_MODELS[key];
  const existing = db.prepare('SELECT * FROM image_model_override WHERE key=?').get(key) as ImageModelOverrideRow | undefined;
  if (!codeDef && !existing) return res.status(404).json({ error: '模型不存在' });
  const v = validModelBody(b);
  if (!v.ok) return res.status(400).json({ error: v.error });
  // 代码内置改 → upsert(shape_template=自身,技术契约取自身);DB 新增改 → 保留原 shape_template。
  const shapeTemplate: string | null = existing?.shape_template ?? (codeDef ? key : null);
  db.prepare(
    `INSERT INTO image_model_override (key,label,model_id,enabled,price_tier,max_images,shape_template,modes,sort_order,resolutions,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET label=excluded.label, model_id=excluded.model_id,
       enabled=excluded.enabled, price_tier=excluded.price_tier, max_images=excluded.max_images,
       modes=excluded.modes, sort_order=excluded.sort_order, resolutions=excluded.resolutions`,
  ).run(key, v.v.label, v.v.modelId, v.v.enabled, v.v.priceTier, v.v.maxImages, shapeTemplate, v.v.modes, v.v.sortOrder, v.v.resolutions, existing?.created_at ?? Date.now());
  writePlatformAudit(req.padmin!.id, 'image_model_update', PLATFORM_TENANT, key, padminIp(req));
  res.json({ ok: true });
});

/** 删除 override(代码内置 → 删 override 回落代码默认;DB 新增 → 整删)。 */
adminRouter.delete('/api/image-models/:key', requirePlatformAdmin, (req: Request, res: Response) => {
  const key = req.params.key!;
  db.prepare('DELETE FROM image_model_override WHERE key=?').run(key);
  writePlatformAudit(req.padmin!.id, 'image_model_delete', PLATFORM_TENANT, key, padminIp(req));
  res.json({ ok: true, note: IMAGE_MODELS[key] ? '已回落代码默认' : '已删除' });
});

/** 排序:接收完整有序 keys 数组,按下标写 sort_order(用户端下拉/admin 列表都按此排)。
 *  代码内置模型无 override 行 → upsert 最小行(只带 sort_order,展示字段回落代码)以承载排序。 */
adminRouter.post('/api/image-models/reorder', requirePlatformAdmin, (req: Request, res: Response) => {
  const keys = (req.body?.keys ?? []) as unknown;
  if (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string'))
    return res.status(400).json({ error: 'keys 需为字符串数组' });
  const tx = db.transaction((ordered: string[]) => {
    ordered.forEach((key, i) => {
      const codeDef = IMAGE_MODELS[key];
      const existing = db.prepare('SELECT * FROM image_model_override WHERE key=?').get(key) as ImageModelOverrideRow | undefined;
      if (!codeDef && !existing) return; // 未知 key 跳过
      if (existing) {
        db.prepare('UPDATE image_model_override SET sort_order=? WHERE key=?').run(i, key);
      } else if (codeDef) {
        // 代码内置首次排序 → 建最小 override 行承载 sort_order(展示/modes 留空=回落代码)
        db.prepare(
          `INSERT INTO image_model_override (key,label,model_id,enabled,price_tier,max_images,shape_template,modes,sort_order,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        ).run(key, codeDef.label, codeDef.modelId, 1, codeDef.priceTier, codeDef.maxImages, key, codeDef.modes.join(','), i, Date.now());
      }
    });
  });
  tx(keys as string[]);
  writePlatformAudit(req.padmin!.id, 'image_model_reorder', PLATFORM_TENANT, keys.join(','), padminIp(req));
  res.json({ ok: true });
});
