// 灵镜 API — 系统设置(机构信息、交付模式、合规标识开关)。
//
// 交付模式(hosted/private)是能力网关切换的依据(PRD §B2);
// 合规标识开关对应 AI 生成标识(§I1)。设置仅 admin 可改,全员可读。

import { Router, type Request, type Response } from 'express';
import { db } from '../db/index.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { audit } from '../audit/index.js';

export const settingsRouter = Router();

// 默认设置(未配置时返回)
const DEFAULTS: Record<string, string> = {
  delivery: 'hosted', // hosted | private
  ai_label_enabled: 'true', // AI 生成标识是否开启(合规)
  ai_label_text: 'AI 生成', // 标识文案
};

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
    delivery: getSetting(tenantId, 'delivery') || t?.delivery || 'hosted',
    aiLabelEnabled: getSetting(tenantId, 'ai_label_enabled') === 'true',
    aiLabelText: getSetting(tenantId, 'ai_label_text'),
  });
});

// 改设置(仅 admin)
settingsRouter.put('/settings', requireRole('admin'), (req: Request, res: Response) => {
  const tenantId = req.user!.tenantId;
  const { orgName, delivery, aiLabelEnabled, aiLabelText } = req.body ?? {};

  if (typeof orgName === 'string' && orgName.trim()) {
    db.prepare(`UPDATE tenant SET name=? WHERE id=?`).run(orgName.trim(), tenantId);
  }
  if (delivery === 'hosted' || delivery === 'private') {
    setSetting(tenantId, 'delivery', delivery);
    db.prepare(`UPDATE tenant SET delivery=? WHERE id=?`).run(delivery, tenantId);
  }
  if (typeof aiLabelEnabled === 'boolean') {
    setSetting(tenantId, 'ai_label_enabled', String(aiLabelEnabled));
  }
  if (typeof aiLabelText === 'string') {
    setSetting(tenantId, 'ai_label_text', aiLabelText);
  }
  audit(req, 'update_settings');
  res.json({ ok: true });
});
