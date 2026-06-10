// 灵镜 — 设置变更字段级审计(T-SETTINGS-AUDIT-DIFF)。
//
// 覆盖:
//   - PUT /settings 改字段 → audit_log 写 detail([{field,old,new}])
//   - 只记真正变了的字段(没改的不进 detail)
//   - 空改动(值未变)→ 不写审计行(无噪声)
//   - detail 经 GET /audit 投影出来

import { describe, it, expect, beforeAll } from 'vitest';

process.env.DB_FILE = ':memory:';

const { db } = await import('../src/db/index.js');
const { createApp } = await import('../src/server.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { Client } = await import('./helpers.js');

const app = createApp();
let tenantId = '';

beforeAll(async () => {
  tenantId = createTenant('审计测试台').id;
  createUser(tenantId, 'auditadmin', 'pw123456', 'admin');
});

async function loginAdmin() {
  const c = new Client(app);
  await c.login('auditadmin', 'pw123456');
  return c;
}
function latestSettingsAudit() {
  return db
    .prepare(`SELECT * FROM audit_log WHERE tenant_id=? AND action='update_settings' ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .get(tenantId) as { detail: string | null } | undefined;
}
function countSettingsAudit() {
  return (db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE tenant_id=? AND action='update_settings'`).get(tenantId) as { n: number }).n;
}

describe('PUT /api/settings 字段级审计', () => {
  it('改 aiLabelEnabled(true→false)+ defaultResolution(720P→480P)→ detail 记两字段旧→新', async () => {
    const c = await loginAdmin();
    // 默认 ai_label_enabled=true、default_resolution=720P;改成真正不同的值才进 diff
    const r = await c.put('/api/settings', { aiLabelEnabled: false, defaultResolution: '480P' });
    expect(r.status).toBe(200);
    const row = latestSettingsAudit();
    expect(row).toBeTruthy();
    const detail = JSON.parse(row!.detail!);
    const fields = detail.map((d: any) => d.field).sort();
    expect(fields).toEqual(['ai_label_enabled', 'default_resolution']);
    const lbl = detail.find((d: any) => d.field === 'ai_label_enabled');
    expect(lbl.old).toBe('true');
    expect(lbl.new).toBe('false');
    const res = detail.find((d: any) => d.field === 'default_resolution');
    expect(res.old).toBe('720P');
    expect(res.new).toBe('480P');
  });

  it('只改一个字段 → detail 只含该字段', async () => {
    const c = await loginAdmin();
    await c.put('/api/settings', { aiLabelText: '本台AI制作' });
    const detail = JSON.parse(latestSettingsAudit()!.detail!);
    expect(detail.length).toBe(1);
    expect(detail[0].field).toBe('ai_label_text');
    expect(detail[0].new).toBe('本台AI制作');
  });

  it('值未变(空改动)→ 不写审计行', async () => {
    const c = await loginAdmin();
    // 先设一个已知值
    await c.put('/api/settings', { defaultResolution: '720P' });
    const before = countSettingsAudit();
    // 再提交同值 → 无变更 → 不写
    const r = await c.put('/api/settings', { defaultResolution: '720P' });
    expect(r.status).toBe(200);
    expect(countSettingsAudit()).toBe(before);
  });

  it('GET /audit 投影 detail', async () => {
    const c = await loginAdmin();
    await c.put('/api/settings', { aiLabelText: '换个文案' });
    const list = await c.get('/api/audit');
    expect(list.status).toBe(200);
    const hit = list.body.find((a: any) => a.action === 'update_settings' && a.detail);
    expect(hit).toBeTruthy();
    expect(typeof hit.detail).toBe('string');
    expect(JSON.parse(hit.detail)[0]).toHaveProperty('old');
    expect(JSON.parse(hit.detail)[0]).toHaveProperty('new');
  });
});
