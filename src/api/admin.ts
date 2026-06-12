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
import {
  listPlans,
  getPlan,
  createPlan,
  updatePlan,
  deletePlan,
  reorderPlans,
  parseFeatures,
  listLeads,
  updateLeadStatus,
  PricingError,
  type PlanInput,
} from '../pricing/index.js';
import type { LeadStatus } from '../db/index.js';
import { countLeadsByStatus } from '../pricing/index.js';
import { IMAGE_MODELS } from '../gateway/image-models.js';
import type { ImageModelOverrideRow } from '../db/index.js';
import { writePlatformAudit, PLATFORM_TENANT, listPlatformAudit } from '../audit/index.js';
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
import multer from 'multer';
import { putObject, getObject } from '../storage/index.js';
import {
  listOrdersByStatus,
  getOrder,
  confirmAndCredit,
  rejectOrder,
  listInvoicesByStatus,
  getInvoice,
  issueInvoice,
  rejectInvoice,
  getPayee,
  setPayee,
} from '../orders/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminPagesDir = resolve(__dirname, '..', '..', 'prototype', 'admin');

export const adminRouter = Router();

// 发票 PDF 上传(超管):内存 + ≤10MB + 仅 PDF。
const invoicePdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

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

// ── 运营监控驾驶舱(平台超管:看各租户任务/并发/瓶颈)──
// 设计来源:/plan-ceo-review 监控规划轮。全部只读聚合 job 表(现有 idx_job_status 索引),
// 零新表、零新依赖。目标:把抽象的"扩容信号"变成超管能看见的一盏瓶颈灯。
//
// 真实瓶颈不是 SQLite(低频长任务,写极少),而是:① 单 worker 吞吐 ② 百炼 API 配额。
// 故监控直接量 queued 深度 / 排队时长 / 失败率,并区分两类瓶颈给运营对症提示。

const DAY_MS = 24 * 60 * 60 * 1000;
/** 今日零点(本地时区,与审计/积分同口径——容器 TZ=Asia/Shanghai)。 */
function startOfTodayMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 瓶颈灯阈值(规划轮定稿):把"何时扩容"从拍脑袋变成数据驱动。
 *  green=健康 / amber=排队偏高(考虑拆多 worker)/ red=已达瓶颈(扩容或查百炼配额)。 */
function bottleneckLevel(queued: number, avgQueueWaitMs: number, failRate: number): 'green' | 'amber' | 'red' {
  if (queued > 15 || avgQueueWaitMs > 120_000 || failRate > 0.1) return 'red';
  if (queued > 5 || avgQueueWaitMs > 30_000) return 'amber';
  return 'green';
}

/** 概览:顶部健康条 + 瓶颈灯。queued/running 是实时快照,今日完成/失败按本地零点切。 */
adminRouter.get('/api/metrics/overview', requirePlatformAdmin, (_req: Request, res: Response) => {
  const todayStart = startOfTodayMs();

  // 实时队列深度(全状态计数)。
  const statusRows = db.prepare(`SELECT status, COUNT(*) AS n FROM job GROUP BY status`).all() as {
    status: string;
    n: number;
  }[];
  const byStatus: Record<string, number> = {};
  for (const r of statusRows) byStatus[r.status] = r.n;
  const queued = byStatus.queued ?? 0;
  const running = byStatus.running ?? 0;

  // 今日完成 / 失败(本地零点起)。
  const today = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status='done'   THEN 1 ELSE 0 END) AS done,
         SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed
       FROM job WHERE created_at >= ?`,
    )
    .get(todayStart) as { done: number | null; failed: number | null };
  const todayDone = today.done ?? 0;
  const todayFailed = today.failed ?? 0;
  const todayTotal = todayDone + todayFailed;
  const failRate = todayTotal > 0 ? todayFailed / todayTotal : 0;

  // 平均生成耗时(今日已完成任务:updated_at - started_at,started_at 非空)。
  const dur = db
    .prepare(
      `SELECT AVG(updated_at - started_at) AS avg
       FROM job WHERE status='done' AND started_at IS NOT NULL AND created_at >= ?`,
    )
    .get(todayStart) as { avg: number | null };
  const avgDurationMs = Math.round(dur.avg ?? 0);

  // 平均排队时长(当前仍在 queued 的任务已等多久:now - created_at)——队列拥堵的直接信号。
  const wait = db
    .prepare(`SELECT AVG(? - created_at) AS avg FROM job WHERE status='queued'`)
    .get(Date.now()) as { avg: number | null };
  const avgQueueWaitMs = Math.round(wait.avg ?? 0);

  const level = bottleneckLevel(queued, avgQueueWaitMs, failRate);

  // new 意向线索待跟进数(咨询式购买落库后无通知,这里给运营一个可见信号,防热线索冷掉)。
  const newLeads = countLeadsByStatus('new');

  return res.json({
    queued,
    running,
    todayDone,
    todayFailed,
    failRate,
    avgDurationMs,
    avgQueueWaitMs,
    level,
    newLeads,
  });
});

/** 租户维度:谁在用、用得怎么样。queued/running 实时,今日量/成功率/P95 按本地零点。 */
adminRouter.get('/api/metrics/by-tenant', requirePlatformAdmin, (_req: Request, res: Response) => {
  const todayStart = startOfTodayMs();

  // 实时:各租户 queued/running 计数。
  const live = db
    .prepare(
      `SELECT tenant_id,
         SUM(CASE WHEN status='queued'  THEN 1 ELSE 0 END) AS queued,
         SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running
       FROM job WHERE status IN ('queued','running') GROUP BY tenant_id`,
    )
    .all() as { tenant_id: string; queued: number; running: number }[];

  // 今日:各租户完成/失败计数(算成功率)。
  const todayAgg = db
    .prepare(
      `SELECT tenant_id,
         SUM(CASE WHEN status='done'   THEN 1 ELSE 0 END) AS done,
         SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed
       FROM job WHERE created_at >= ? GROUP BY tenant_id`,
    )
    .all(todayStart) as { tenant_id: string; done: number; failed: number }[];

  // 今日已完成任务的耗时数组(P95 在 JS 算——SQLite 无原生 percentile)。
  const durRows = db
    .prepare(
      `SELECT tenant_id, (updated_at - started_at) AS d
       FROM job WHERE status='done' AND started_at IS NOT NULL AND created_at >= ?`,
    )
    .all(todayStart) as { tenant_id: string; d: number }[];
  const durByTenant = new Map<string, number[]>();
  for (const r of durRows) {
    const arr = durByTenant.get(r.tenant_id) ?? [];
    arr.push(r.d);
    durByTenant.set(r.tenant_id, arr);
  }
  const p95 = (arr: number[]): number => {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
    return Math.round(sorted[idx]!);
  };

  // 并起来:涉及今日有活动或当前有在途任务的租户全集。
  const tenants = db.prepare(`SELECT id, name FROM tenant`).all() as { id: string; name: string }[];
  const nameById = new Map(tenants.map((t) => [t.id, t.name]));
  const liveById = new Map(live.map((r) => [r.tenant_id, r]));
  const todayById = new Map(todayAgg.map((r) => [r.tenant_id, r]));
  const ids = new Set<string>([...liveById.keys(), ...todayById.keys()]);

  const items = [...ids].map((id) => {
    const l = liveById.get(id);
    const t = todayById.get(id);
    const done = t?.done ?? 0;
    const failed = t?.failed ?? 0;
    const total = done + failed;
    return {
      tenantId: id,
      name: nameById.get(id) ?? id, // 老 default 租户可能无 tenant 行 → 回退 id
      queued: l?.queued ?? 0,
      running: l?.running ?? 0,
      todayCount: total,
      successRate: total > 0 ? done / total : 1,
      p95DurationMs: p95(durByTenant.get(id) ?? []),
    };
  });
  // 在途多的排前(运营先看正在消耗资源的)。
  items.sort((a, b) => b.running + b.queued - (a.running + a.queued) || b.todayCount - a.todayCount);
  return res.json({ tenants: items });
});

/** 并发趋势:近 N 小时按小时分桶,看历史峰值贴没贴到容量上限。
 *  实时算(MVP):running 是瞬态,用 started_at/updated_at 落桶近似——同时活跃任务数。 */
adminRouter.get('/api/metrics/concurrency', requirePlatformAdmin, (req: Request, res: Response) => {
  const range = String(req.query.range ?? '24h');
  const hours = range === '7d' ? 24 * 7 : range === '48h' ? 48 : 24;
  const now = Date.now();
  const since = now - hours * 60 * 60 * 1000;

  // 每小时桶:该小时内"启动过"的任务计为该桶活跃(近似并发);并附完成/失败数。
  const rows = db
    .prepare(
      `SELECT
         CAST((COALESCE(started_at, created_at) - ?) / 3600000 AS INTEGER) AS bucket,
         SUM(CASE WHEN status='done'   THEN 1 ELSE 0 END) AS done,
         SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
         COUNT(*) AS active
       FROM job
       WHERE COALESCE(started_at, created_at) >= ?
       GROUP BY bucket ORDER BY bucket`,
    )
    .all(since, since) as { bucket: number; done: number; failed: number; active: number }[];

  const byBucket = new Map(rows.map((r) => [r.bucket, r]));
  const series = Array.from({ length: hours }, (_, i) => {
    const r = byBucket.get(i);
    return {
      hourStart: since + i * 3600000,
      active: r?.active ?? 0,
      done: r?.done ?? 0,
      failed: r?.failed ?? 0,
    };
  });
  return res.json({ range, hours, series });
});

/** 某租户最近任务流(点开租户行展开)。input_json/output_url 不下发(隐私+体积),只给运营要看的字段。 */
adminRouter.get('/api/metrics/recent-jobs', requirePlatformAdmin, (req: Request, res: Response) => {
  const tenant = req.query.tenant ? String(req.query.tenant) : null;
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const rows = (
    tenant
      ? db
          .prepare(
            `SELECT id, tenant_id, type, status, progress, attempts, error, created_at, started_at, updated_at
             FROM job WHERE tenant_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
          )
          .all(tenant, limit)
      : db
          .prepare(
            `SELECT id, tenant_id, type, status, progress, attempts, error, created_at, started_at, updated_at
             FROM job ORDER BY created_at DESC, rowid DESC LIMIT ?`,
          )
          .all(limit)
  ) as Record<string, unknown>[];
  // 附耗时(done 的算 updated_at-started_at;其余 null)。
  const jobs = rows.map((r) => ({
    ...r,
    durationMs:
      r.status === 'done' && r.started_at ? Number(r.updated_at) - Number(r.started_at) : null,
  }));
  return res.json({ jobs });
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

// ── 积分套餐管理(/plan-design-review + /plan-eng-review)──
// 照 image-models 范式:admin 增删改启停排序,改完前台 GET /api/pricing-plans 即时生效。
// 校验在 pricing/index.ts(单一来源),本路由只解析 body + 调用 + 透传 PricingError。

/** 从请求体解析 PlanInput(类型收敛;空值容错)。 */
function parsePlanBody(b: Record<string, unknown>): PlanInput {
  const priceRaw = b.priceYuan;
  return {
    name: typeof b.name === 'string' ? b.name : '',
    // priceYuan:null/空字符串/undefined → null(面议);否则转 number。
    priceYuan: priceRaw === null || priceRaw === undefined || priceRaw === '' ? null : Number(priceRaw),
    credits: Number(b.credits),
    bonusCredits: b.bonusCredits === undefined ? 0 : Number(b.bonusCredits),
    validityMonths: b.validityMonths === undefined ? 12 : Number(b.validityMonths),
    features: Array.isArray(b.features) ? (b.features as unknown[]).map(String).filter((s) => s.trim()) : [],
    flag: typeof b.flag === 'string' && b.flag.trim() ? b.flag.trim() : null,
    enabled: b.enabled !== false && b.enabled !== 0,
  };
}

/** 列全部套餐(含停用);features 解析为数组供 admin 编辑回填。 */
adminRouter.get('/api/pricing-plans', requirePlatformAdmin, (_req: Request, res: Response) => {
  const plans = listPlans().map((p) => ({ ...p, features: parseFeatures(p.features) }));
  res.json({ plans });
});

adminRouter.post('/api/pricing-plans', requirePlatformAdmin, (req: Request, res: Response) => {
  try {
    const plan = createPlan(parsePlanBody((req.body ?? {}) as Record<string, unknown>));
    writePlatformAudit(req.padmin!.id, 'pricing_plan_create', PLATFORM_TENANT, plan.name, padminIp(req));
    res.status(201).json({ id: plan.id });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '创建失败', ...(e instanceof PricingError ? { code: e.code } : {}) });
  }
});

adminRouter.put('/api/pricing-plans/:id', requirePlatformAdmin, (req: Request, res: Response) => {
  const id = req.params.id!;
  if (!getPlan(id)) return res.status(404).json({ error: '套餐不存在' });
  try {
    updatePlan(id, parsePlanBody((req.body ?? {}) as Record<string, unknown>));
    writePlatformAudit(req.padmin!.id, 'pricing_plan_update', PLATFORM_TENANT, id, padminIp(req));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '更新失败', ...(e instanceof PricingError ? { code: e.code } : {}) });
  }
});

adminRouter.delete('/api/pricing-plans/:id', requirePlatformAdmin, (req: Request, res: Response) => {
  const id = req.params.id!;
  const ok = deletePlan(id);
  if (!ok) return res.status(404).json({ error: '套餐不存在' });
  writePlatformAudit(req.padmin!.id, 'pricing_plan_delete', PLATFORM_TENANT, id, padminIp(req));
  res.json({ ok: true });
});

adminRouter.post('/api/pricing-plans/reorder', requirePlatformAdmin, (req: Request, res: Response) => {
  const ids = req.body?.ids as unknown;
  if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string'))
    return res.status(400).json({ error: 'ids 需为字符串数组' });
  reorderPlans(ids as string[]);
  writePlatformAudit(req.padmin!.id, 'pricing_plan_reorder', PLATFORM_TENANT, ids.join(','), padminIp(req));
  res.json({ ok: true });
});

// ── 意向线索(运营跟进)──
adminRouter.get('/api/sales-leads', requirePlatformAdmin, (req: Request, res: Response) => {
  const status = req.query.status ? String(req.query.status) : undefined;
  const valid = status === 'new' || status === 'contacted' || status === 'closed';
  const leads = listLeads({ status: valid ? (status as LeadStatus) : undefined });
  res.json({ leads });
});

adminRouter.put('/api/sales-leads/:id', requirePlatformAdmin, (req: Request, res: Response) => {
  const id = req.params.id!;
  const { status, note } = (req.body ?? {}) as { status?: string; note?: string };
  if (status !== 'new' && status !== 'contacted' && status !== 'closed')
    return res.status(400).json({ error: '无效状态' });
  try {
    const ok = updateLeadStatus(id, status, note);
    if (!ok) return res.status(404).json({ error: '线索不存在' });
    writePlatformAudit(req.padmin!.id, 'sales_lead_update', PLATFORM_TENANT, `${id}→${status}`, padminIp(req));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : '更新失败' });
  }
});

// ── 对公充值:收款核对工作台 ──

function serializeAdminOrder(o: ReturnType<typeof getOrder> & object, tenantName: string) {
  return {
    id: o!.id,
    orderNo: o!.order_no,
    tenantId: o!.tenant_id,
    tenantName, // 哪个租户提交的(超管核对/处理用;JOIN tenant 解析)
    planName: o!.plan_name,
    priceYuan: o!.price_yuan,
    credits: o!.credits,
    bonusCredits: o!.bonus_credits,
    status: o!.status,
    hasReceipt: !!o!.receipt_key,
    adminNote: o!.admin_note,
    createdAt: o!.created_at,
  };
}

// 列待核对(paid_claimed)订单。带租户名供超管识别是哪个机构提交的。
adminRouter.get('/api/recharge-orders', requirePlatformAdmin, (req: Request, res: Response) => {
  const status = (req.query.status as string) || 'paid_claimed';
  const valid = ['pending_payment', 'paid_claimed', 'credited', 'rejected', 'cancelled'];
  if (!valid.includes(status)) return res.status(400).json({ error: '无效状态' });
  const orders = listOrdersByStatus(status as never);
  // 批量解析租户名(避免 N 次单查)。
  const names = new Map<string, string>();
  for (const o of orders) {
    if (names.has(o.tenant_id)) continue;
    const t = db.prepare(`SELECT name FROM tenant WHERE id=?`).get(o.tenant_id) as
      | { name: string }
      | undefined;
    names.set(o.tenant_id, t?.name ?? '(已删租户)');
  }
  res.json({ orders: orders.map((o) => serializeAdminOrder(o, names.get(o.tenant_id) ?? '')) });
});

// 看回单截图(超管,流式)。
adminRouter.get('/api/recharge-orders/:id/receipt', requirePlatformAdmin, async (req: Request, res: Response) => {
  const o = getOrder(req.params.id!);
  if (!o || !o.receipt_key) return res.status(404).json({ error: '回单不存在' });
  try {
    const buf = await getObject(o.receipt_key);
    res.setHeader('Content-Disposition', `attachment; filename="receipt-${o.order_no}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(buf);
  } catch {
    res.status(404).json({ error: '回单文件不存在' });
  }
});

// ★钱路★ 确认到账:paid_claimed → credited + grant(原子,只一次)。
adminRouter.post('/api/recharge-orders/:id/confirm', requirePlatformAdmin, (req: Request, res: Response) => {
  const o = getOrder(req.params.id!);
  if (!o) return res.status(404).json({ error: '订单不存在' });
  const ok = confirmAndCredit(o.id, req.padmin!.id);
  if (!ok) return res.status(409).json({ error: '订单非待确认状态(可能已处理)' });
  writePlatformAudit(req.padmin!.id, 'order_confirm', o.tenant_id, `${o.order_no}/+${o.credits + o.bonus_credits}`, padminIp(req));
  res.json({ ok: true });
});

// 驳回:paid_claimed → rejected(带原因)。
adminRouter.post('/api/recharge-orders/:id/reject', requirePlatformAdmin, (req: Request, res: Response) => {
  const { note } = (req.body ?? {}) as { note?: string };
  if (!note || !note.trim()) return res.status(400).json({ error: '请填写驳回原因' });
  const o = getOrder(req.params.id!);
  if (!o) return res.status(404).json({ error: '订单不存在' });
  const ok = rejectOrder(o.id, req.padmin!.id, note.trim());
  if (!ok) return res.status(409).json({ error: '订单非待确认状态' });
  writePlatformAudit(req.padmin!.id, 'order_reject', o.tenant_id, o.order_no, padminIp(req));
  res.json({ ok: true });
});

// ── 发票开具工作台 ──

// 列待开票(requested)发票。
adminRouter.get('/api/admin-invoices', requirePlatformAdmin, (req: Request, res: Response) => {
  const status = (req.query.status as string) || 'requested';
  if (status !== 'requested' && status !== 'issued') return res.status(400).json({ error: '无效状态' });
  res.json({
    invoices: listInvoicesByStatus(status as never).map((inv) => ({
      id: inv.id,
      orderNos: inv.orderNos ?? [], // 一票多单展示号(供超管核对入账)
      orderCount: (inv.orderIds ?? []).length,
      tenantId: inv.tenant_id,
      title: inv.title,
      taxNo: inv.tax_no,
      kind: inv.kind,
      amountYuan: inv.amount_yuan,
      status: inv.status,
      invoiceNo: inv.invoice_no,
      createdAt: inv.created_at,
    })),
  });
});

// 回填发票号 + 上传 PDF → issued。
adminRouter.post(
  '/api/admin-invoices/:id/issue',
  requirePlatformAdmin,
  invoicePdfUpload.single('pdf'),
  async (req: Request, res: Response) => {
    const { invoiceNo } = (req.body ?? {}) as { invoiceNo?: string };
    if (!invoiceNo || !invoiceNo.trim()) return res.status(400).json({ error: '请填写发票号' });
    const inv = getInvoice(req.params.id!);
    if (!inv) return res.status(404).json({ error: '发票不存在' });
    let pdfKey: string | null = null;
    const file = req.file;
    if (file) {
      if (file.mimetype !== 'application/pdf')
        return res.status(400).json({ error: '发票文件仅支持 PDF' });
      pdfKey = `invoices/${inv.tenant_id}/${inv.id}.pdf`;
      await putObject(pdfKey, file.buffer, 'application/pdf');
    }
    const ok = issueInvoice(inv.id, invoiceNo.trim(), pdfKey);
    if (!ok) return res.status(409).json({ error: '发票非待开票状态' });
    writePlatformAudit(req.padmin!.id, 'invoice_issue', inv.tenant_id, `${inv.id}/${invoiceNo.trim()}`, padminIp(req));
    res.json({ ok: true });
  },
);

// 驳回开票:requested → 删行(退回,用户可重申)。
adminRouter.post('/api/admin-invoices/:id/reject', requirePlatformAdmin, (req: Request, res: Response) => {
  const inv = getInvoice(req.params.id!);
  if (!inv) return res.status(404).json({ error: '发票不存在' });
  const ok = rejectInvoice(inv.id);
  if (!ok) return res.status(409).json({ error: '发票非待开票状态' });
  writePlatformAudit(req.padmin!.id, 'invoice_reject', inv.tenant_id, inv.id, padminIp(req));
  res.json({ ok: true });
});

// ── 对公收款信息配置(真实银行账号存这里,不进代码/git)──
adminRouter.get('/api/payee', requirePlatformAdmin, (_req: Request, res: Response) => {
  const p = getPayee();
  res.json({ payeeName: p.payee_name, taxNo: p.tax_no, bankName: p.bank_name, bankAccount: p.bank_account });
});

adminRouter.post('/api/payee', requirePlatformAdmin, (req: Request, res: Response) => {
  const { payeeName, taxNo, bankName, bankAccount } = (req.body ?? {}) as Record<string, string>;
  if (!payeeName?.trim() || !bankName?.trim() || !bankAccount?.trim())
    return res.status(400).json({ error: '户名/开户行/账号必填' });
  setPayee({
    payeeName: payeeName.trim(),
    taxNo: (taxNo ?? '').trim(),
    bankName: bankName.trim(),
    bankAccount: bankAccount.trim(),
  });
  writePlatformAudit(req.padmin!.id, 'payee_update', PLATFORM_TENANT, payeeName.trim(), padminIp(req));
  res.json({ ok: true });
});

// ── 平台审计:所有超管操作(跨租户 + 纯平台),供超管追溯 ──
// 平台操作绝不进租户审计(信任边界,见 audit/index.ts listAudit);这里是唯一查看入口。
adminRouter.get('/api/audit', requirePlatformAdmin, (req: Request, res: Response) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
  const rows = listPlatformAudit(limit);
  // 解析目标租户名(纯平台操作 tenant_id=PLATFORM_TENANT → 显「平台」)。
  const names = new Map<string, string>();
  for (const r of rows) {
    if (r.tenant_id === PLATFORM_TENANT || names.has(r.tenant_id)) continue;
    const t = db.prepare(`SELECT name FROM tenant WHERE id=?`).get(r.tenant_id) as
      | { name: string }
      | undefined;
    names.set(r.tenant_id, t?.name ?? '(已删租户)');
  }
  res.json({
    audit: rows.map((r) => ({
      createdAt: r.created_at,
      actorName: r.actorName ?? '未知超管',
      action: r.action,
      target: r.target,
      tenant: r.tenant_id === PLATFORM_TENANT ? null : names.get(r.tenant_id) ?? null,
      ip: r.ip,
    })),
  });
});
