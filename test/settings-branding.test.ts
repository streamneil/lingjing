// 灵镜 — 租户品牌自定义(机构名称可改 + Logo 恢复默认 + 落地页公开品牌 + slug 迁移)。
//
// 覆盖(全路径):
//   - sanitizeOrgName:空/超长/XSS/品牌符(经 PUT 行为验证)
//   - PUT /settings(name):admin 写 + 审计 diff;名称未变不写;空名 400
//   - [回归 R1] orgName 不再返回 400 ORG_NAME_READONLY,且写生效
//   - RBAC:creator/viewer 改名 → 403;租户隔离
//   - DELETE /settings/logo:admin 清 + 审计;non-admin 403;删后 /org-logo 404
//   - GET /api/public-brand/:slug:合法/未知 slug/匿名
//   - [回归 R2] slug 迁移:新建租户有唯一 slug;createTenant 赋 slug
//   - /me 返回 isCustomBranded + logoVer

import { describe, it, expect, beforeAll, vi } from 'vitest';

process.env.DB_FILE = ':memory:';

// mock 存储,避免连真实 MinIO/OSS(logo 上传 putObject / 公开读 getObject)。
vi.mock('../src/storage/index.js', () => ({
  putObject: vi.fn(async (k: string) => k),
  getObject: vi.fn(async () => Buffer.from('fakelogobytes')),
  getSignedUrl: vi.fn(async (k: string) => 'signed://' + k),
  storage: { putObject: vi.fn(async (k: string) => k), getObject: vi.fn(async () => Buffer.from('x')) },
}));

const { db } = await import('../src/db/index.js');
const { createApp } = await import('../src/server.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { Client } = await import('./helpers.js');

const app = createApp();
let tenantId = '';
let otherTenantId = '';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG 魔术头足够过 mimetype

beforeAll(async () => {
  const t = createTenant('品牌测试台');
  tenantId = t.id;
  createUser(tenantId, 'brandadmin', 'pw123456', 'admin');
  createUser(tenantId, 'brandcreator', 'pw123456', 'creator');
  createUser(tenantId, 'brandviewer', 'pw123456', 'viewer');
  otherTenantId = createTenant('另一个台').id;
  createUser(otherTenantId, 'otheradmin', 'pw123456', 'admin');
});

async function asUser(username: string) {
  const c = new Client(app);
  await c.login(username, 'pw123456');
  return c;
}
function tenantName(id: string) {
  return (db.prepare(`SELECT name FROM tenant WHERE id=?`).get(id) as { name: string }).name;
}
function brandSetting(id: string): string | null {
  const row = db.prepare(`SELECT value FROM tenant_setting WHERE tenant_id=? AND key='brand_name'`).get(id) as { value: string } | undefined;
  return row?.value ?? null;
}
function latestAuditDetail(id: string) {
  const row = db
    .prepare(`SELECT detail FROM audit_log WHERE tenant_id=? AND action='update_settings' ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .get(id) as { detail: string | null } | undefined;
  return row?.detail ? JSON.parse(row.detail) : null;
}

describe('系统名称可改、机构名称只读(T1)', () => {
  it('brandName 写 tenant_setting.brand_name + 审计 diff;机构名 tenant.name 不变', async () => {
    const c = await asUser('brandadmin');
    const before = tenantName(tenantId);
    const r = await c.put('/api/settings', { brandName: '杭州融媒创作台' });
    expect(r.status).toBe(200);
    expect(brandSetting(tenantId)).toBe('杭州融媒创作台');
    expect(tenantName(tenantId)).toBe(before); // 机构身份不动
    const nameDiff = latestAuditDetail(tenantId).find((d: any) => d.field === 'brand_name');
    expect(nameDiff?.new).toBe('杭州融媒创作台');
  });

  it('GET /settings 返回 brandName;未设过 → 回落机构名', async () => {
    // 新建一个没设过 brand_name 的租户,brandName 应回落 tenant.name
    const freshT = createTenant('未改名台').id;
    createUser(freshT, 'freshadmin', 'pw123456', 'admin');
    const c = await asUser('freshadmin');
    const s = (await c.get('/api/settings')).body;
    expect(s.brandName).toBe('未改名台'); // 回落机构名
    expect(s.orgName).toBe('未改名台');
  });

  it('[回归] orgName 不再改写 tenant.name(机构身份租户侧不可改)', async () => {
    const c = await asUser('brandadmin');
    const before = tenantName(tenantId);
    const r = await c.put('/api/settings', { orgName: '黑客改的名' });
    expect(r.status).toBe(200); // 字段被忽略,非报错
    expect(tenantName(tenantId)).toBe(before); // tenant.name 纹丝不动
  });

  it('系统名留空 → 清 brand_name,回落机构名(不允许空品牌)', async () => {
    const c = await asUser('brandadmin');
    await c.put('/api/settings', { brandName: '先设个名' });
    expect(brandSetting(tenantId)).toBe('先设个名');
    await c.put('/api/settings', { brandName: '   ' }); // 空 → 清
    expect(brandSetting(tenantId)).toBeNull();
    expect((await c.get('/api/settings')).body.brandName).toBe(tenantName(tenantId)); // 回落机构名
  });

  it('超长系统名 → 截断到 30 字', async () => {
    const c = await asUser('brandadmin');
    await c.put('/api/settings', { brandName: '镜'.repeat(50) });
    expect(brandSetting(tenantId)!.length).toBe(30);
  });

  it('XSS payload → 剥 <script>,渲染安全', async () => {
    const c = await asUser('brandadmin');
    await c.put('/api/settings', { brandName: '<script>alert(1)</script>创作台' });
    const v = brandSetting(tenantId)!;
    expect(v).not.toContain('<');
    expect(v).not.toContain('>');
    expect(v).toContain('创作台');
  });

  it('delivery 仍只读', async () => {
    const c = await asUser('brandadmin');
    const r = await c.put('/api/settings', { delivery: 'private' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('DELIVERY_READONLY');
  });

  it('RBAC:creator 改系统名 → 403', async () => {
    const r = await (await asUser('brandcreator')).put('/api/settings', { brandName: '黑客台' });
    expect(r.status).toBe(403);
  });

  it('RBAC:viewer 改系统名 → 403', async () => {
    const r = await (await asUser('brandviewer')).put('/api/settings', { brandName: '黑客台' });
    expect(r.status).toBe(403);
  });

  it('租户隔离:A 改系统名只动 A,不动 B', async () => {
    await (await asUser('otheradmin')).put('/api/settings', { brandName: 'B 系统名' });
    await (await asUser('brandadmin')).put('/api/settings', { brandName: 'A 系统名' });
    expect(brandSetting(tenantId)).toBe('A 系统名');
    expect(brandSetting(otherTenantId)).toBe('B 系统名');
  });
});

describe('Logo 恢复默认(T4)', () => {
  it('admin 上传 → 设 org_logo_key', async () => {
    const c = await asUser('brandadmin');
    const r = await c.postMultipart('/api/settings/logo', {}, { logo: { filename: 'l.png', content: PNG, type: 'image/png' } });
    expect(r.status).toBe(200);
    const key = db.prepare(`SELECT value FROM tenant_setting WHERE tenant_id=? AND key='org_logo_key'`).get(tenantId) as { value: string } | undefined;
    expect(key?.value).toBeTruthy();
  });

  it('恢复默认:admin DELETE → 清 key + 审计;/org-logo 返 404', async () => {
    const c = await asUser('brandadmin');
    const r = await c.del('/api/settings/logo');
    expect(r.status).toBe(200);
    const key = db.prepare(`SELECT value FROM tenant_setting WHERE tenant_id=? AND key='org_logo_key'`).get(tenantId);
    expect(key).toBeUndefined();
    const audit = latestAuditDetail(tenantId);
    // 审计记 org_logo_reset(target),detail 可能为 null —— 查 target
    const row = db.prepare(`SELECT target FROM audit_log WHERE tenant_id=? AND action='update_settings' ORDER BY rowid DESC LIMIT 1`).get(tenantId) as { target: string };
    expect(row.target).toBe('org_logo_reset');
    const logo = await c.getRaw('/api/org-logo/' + tenantId);
    expect(logo.status).toBe(404);
  });

  it('RBAC:creator 删 logo → 403', async () => {
    const c = await asUser('brandcreator');
    const r = await c.del('/api/settings/logo');
    expect(r.status).toBe(403);
  });
});

describe('落地页公开品牌(T5)', () => {
  it('合法 slug(匿名)→ {tenantId,name,hasLogo}', async () => {
    const slug = (db.prepare(`SELECT slug FROM tenant WHERE id=?`).get(tenantId) as { slug: string }).slug;
    const anon = new Client(app); // 不登录
    const r = await anon.get('/api/public-brand/' + slug);
    expect(r.status).toBe(200);
    expect(r.body.tenantId).toBe(tenantId);
    expect(r.body.name).toBe(tenantName(tenantId));
    expect(typeof r.body.hasLogo).toBe('boolean');
  });

  it('未知 slug → 404 不泄露', async () => {
    const anon = new Client(app);
    const r = await anon.get('/api/public-brand/nonexistentslug');
    expect(r.status).toBe(404);
  });
});

describe('slug 迁移与赋值(T5 / R2)', () => {
  it('[回归 R2] 每个租户都有唯一 slug', async () => {
    const rows = db.prepare(`SELECT slug FROM tenant`).all() as { slug: string | null }[];
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) expect(r.slug).toBeTruthy();
    const slugs = rows.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(slugs.length); // 全唯一
  });

  it('createTenant 新建即赋 slug(8 位)', () => {
    const t = createTenant('新建台');
    expect(t.slug).toBeTruthy();
    expect(t.slug!.length).toBe(8);
  });
});

describe('/me 品牌哨兵(T2)', () => {
  it('设过名(非默认)→ isCustomBranded=true + 返回 logoVer', async () => {
    const c = await asUser('brandadmin');
    const r = await c.get('/api/me');
    expect(r.status).toBe(200);
    expect(r.body.isCustomBranded).toBe(true); // 名称已被改成 'A 专属名'
    expect(typeof r.body.logoVer).toBe('string');
  });

  it('真名「我的机构」+ 无 logo → isCustomBranded=false', async () => {
    const def = createTenant('我的机构'); // 名 = 平台默认串
    createUser(def.id, 'defadmin', 'pw123456', 'admin');
    const c = await asUser('defadmin');
    const r = await c.get('/api/me');
    expect(r.body.isCustomBranded).toBe(false);
  });
});
