// 灵镜 API — 系统设置(机构信息、交付模式、合规标识开关)。
//
// 交付模式(hosted/private)是能力网关切换的依据(PRD §B2);
// 合规标识开关对应 AI 生成标识(§I1)。设置仅 admin 可改,全员可读。

import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import multer from 'multer';
import { db } from '../db/index.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { audit } from '../audit/index.js';
import { putObject, getObject } from '../storage/index.js';

export const settingsRouter = Router();

// 机构 Logo 上传:独立 multer —— 仅位图(不收 SVG 防存储型 XSS)+ 5MB(logo 不需大)。
const LOGO_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};
const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (LOGO_MIME[file.mimetype]) cb(null, true);
    else cb(new Error('仅支持 PNG / JPEG / WEBP 图片'));
  },
});

// 默认设置(未配置时返回)
const DEFAULTS: Record<string, string> = {
  delivery: 'hosted', // hosted | private(只读:部署时定,不可运行时改)
  ai_label_enabled: 'true', // AI 生成标识是否开启(合规)
  ai_label_text: 'AI 生成', // 标识文案
  default_resolution: '720P', // 机构默认分辨率(创作台新建时 seed)
  // 注:不做 default_ratio —— wan2.2-s2v 比例由形象图决定(gateway/types.ts:13),设它无效。
};

// AI 标识文案进 ffmpeg drawtext,转义/限制防滤镜串注入(`:`'`\`%{}` 等)。
// 策略:限长 + 只保留中英数字与常见标点空格,其余剔除(白名单,最稳)。
function sanitizeLabelText(raw: string): string {
  return raw
    .slice(0, 20)
    .replace(/[^一-龥A-Za-z0-9 ·。,、!?\-]/g, '')
    .trim();
}

function getSetting(tenantId: string, key: string): string {
  const row = db
    .prepare(`SELECT value FROM tenant_setting WHERE tenant_id=? AND key=?`)
    .get(tenantId, key) as { value: string } | undefined;
  return row?.value ?? DEFAULTS[key] ?? '';
}

function setSetting(tenantId: string, key: string, value: string): void {
  db.prepare(
    `INSERT INTO tenant_setting (tenant_id,key,value) VALUES (?,?,?)
     ON CONFLICT(tenant_id,key) DO UPDATE SET value=excluded.value`,
  ).run(tenantId, key, value);
}

// 读设置(全员)
settingsRouter.get('/settings', requireAuth, (req: Request, res: Response) => {
  const tenantId = req.user!.tenantId;
  const t = db.prepare(`SELECT name,delivery FROM tenant WHERE id=?`).get(tenantId) as
    | { name: string; delivery: string }
    | undefined;
  res.json({
    orgName: t?.name ?? '',
    delivery: getSetting(tenantId, 'delivery') || t?.delivery || 'hosted', // 只读展示
    aiLabelEnabled: getSetting(tenantId, 'ai_label_enabled') === 'true',
    aiLabelText: getSetting(tenantId, 'ai_label_text'),
    defaultResolution: getSetting(tenantId, 'default_resolution'),
    orgLogoKey: getSetting(tenantId, 'org_logo_key'), // 存的是 key,前端拼 /api/org-logo/<tenant>
  });
});

// 改设置(仅 admin)
settingsRouter.put('/settings', requireRole('admin'), (req: Request, res: Response) => {
  const tenantId = req.user!.tenantId;
  const { orgName, delivery, aiLabelEnabled, aiLabelText, defaultResolution } = req.body ?? {};

  // 交付模式只读:部署时确定,不允许运行时改(防误改底层能力网关路径)。
  if (delivery !== undefined) {
    return res.status(400).json({ error: '交付模式不可运行时修改,请联系部署方', code: 'DELIVERY_READONLY' });
  }
  if (defaultResolution !== undefined && !['720P', '480P'].includes(defaultResolution)) {
    return res.status(400).json({ error: '默认分辨率非法(仅 720P / 480P)' });
  }

  if (typeof orgName === 'string' && orgName.trim()) {
    db.prepare(`UPDATE tenant SET name=? WHERE id=?`).run(orgName.trim(), tenantId);
  }
  if (typeof aiLabelEnabled === 'boolean') {
    setSetting(tenantId, 'ai_label_enabled', String(aiLabelEnabled));
  }
  if (typeof aiLabelText === 'string') {
    setSetting(tenantId, 'ai_label_text', sanitizeLabelText(aiLabelText) || 'AI 生成');
  }
  if (defaultResolution === '720P' || defaultResolution === '480P') {
    setSetting(tenantId, 'default_resolution', defaultResolution);
  }
  audit(req, 'update_settings');
  res.json({ ok: true });
});

// 机构 Logo 上传(仅 admin)。存 object key(非签名 URL,避免过期);仅位图 + 5MB。
settingsRouter.post('/settings/logo', requireRole('admin'), (req: Request, res: Response) => {
  logoUpload.single('logo')(req, res, async (err: unknown) => {
    if (err) {
      // multer fileFilter / 大小超限错误 → 400 清晰提示
      const msg = err instanceof Error ? err.message : '上传失败';
      return res.status(400).json({ error: msg.includes('File too large') ? 'Logo 超过 5MB 上限' : msg });
    }
    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file) return res.status(400).json({ error: '缺少 logo 文件' });
    const ext = LOGO_MIME[file.mimetype] ?? 'png';
    const key = `logos/${req.user!.tenantId}/${randomUUID()}.${ext}`;
    try {
      await putObject(key, file.buffer, file.mimetype);
    } catch {
      return res.status(502).json({ error: 'Logo 存储失败,请稍后重试' });
    }
    setSetting(req.user!.tenantId, 'org_logo_key', key);
    audit(req, 'update_settings', 'org_logo');
    res.json({ ok: true });
  });
});

// 机构 Logo 公开读(非敏感,机构品牌图):前端拼固定路径 /api/org-logo/<tenant>,
// 直出图片字节(浏览器可达,无需签名 URL,不每请求签名)。仅服务该租户已设的 logo。
settingsRouter.get('/org-logo/:tenantId', async (req: Request, res: Response) => {
  const key = getSetting(req.params.tenantId!, 'org_logo_key');
  if (!key) return res.status(404).end();
  try {
    const buf = await getObject(key);
    const ext = key.split('.').pop() ?? 'png';
    const ct = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'private, max-age=300'); // 5min 缓存,减重复拉取
    res.end(buf);
  } catch {
    res.status(404).end(); // 取不到(已删/坏)→ 404,前端 onerror 回退默认图标
  }
});
