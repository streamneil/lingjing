// 灵镜 系统设置升级测试 —— 默认分辨率 / delivery 拒绝 / aiLabelText 校验 /
// 480P 计费 / Logo 上传安全(mock 存储)。覆盖 eng-review 11 路径(5 CRITICAL=Logo 安全)。

import { describe, it, expect, beforeAll, vi } from 'vitest';

process.env.DB_FILE = ':memory:';

// mock 存储:Logo 上传/读取不连真实 MinIO/OSS。
vi.mock('../src/storage/index.js', () => ({
  putObject: vi.fn(async (k: string) => k),
  getObject: vi.fn(async () => Buffer.from('fakepng')),
  getSignedUrl: vi.fn(async (k: string) => 'signed://' + k),
  storage: { putObject: vi.fn(async (k: string) => k), getSignedUrl: vi.fn(async (k: string) => k) },
}));

const { createApp } = await import('../src/server.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { estimateCost } = await import('../src/credits/index.js');
const { Client } = await import('./helpers.js');

const app = createApp();
let tenantId: string;

beforeAll(() => {
  tenantId = createTenant('设置测试台').id;
  createUser(tenantId, 'set_admin', 'pw123456', 'admin');
  createUser(tenantId, 'set_viewer', 'pw123456', 'viewer');
});

async function loginAs(username: string) {
  const c = new Client(app);
  await c.login(username, 'pw123456');
  return c;
}
const png = (size = 100) => ({ filename: 'logo.png', content: Buffer.alloc(size, 1), type: 'image/png' });

describe('默认分辨率', () => {
  it('admin 设 480P → 存 + GET 回读', async () => {
    const c = await loginAs('set_admin');
    expect((await c.put('/api/settings', { defaultResolution: '480P' })).status).toBe(200);
    const g = await c.get('/api/settings');
    expect(g.body.defaultResolution).toBe('480P');
  });
  it('非法分辨率 → 400', async () => {
    const c = await loginAs('set_admin');
    expect((await c.put('/api/settings', { defaultResolution: '8K' })).status).toBe(400);
  });
  it('未设时 GET 兜底 720P', async () => {
    const t2 = createTenant('未设台').id;
    createUser(t2, 'fresh_admin', 'pw123456', 'admin');
    const c = await loginAs('fresh_admin');
    expect((await c.get('/api/settings')).body.defaultResolution).toBe('720P');
  });
});

describe('交付模式只读(后端拒绝)', () => {
  it('PUT 带 delivery → 400 DELIVERY_READONLY', async () => {
    const c = await loginAs('set_admin');
    const r = await c.put('/api/settings', { delivery: 'private' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('DELIVERY_READONLY');
  });
});

describe('aiLabelText 校验', () => {
  it('注入字符被转义/剔除', async () => {
    const c = await loginAs('set_admin');
    await c.put('/api/settings', { aiLabelText: "AI:'\\%{evil}" });
    const g = await c.get('/api/settings');
    // 危险字符(: ' \ % { })应被剔除,只剩安全字
    expect(g.body.aiLabelText).not.toMatch(/[:'\\%{}]/);
  });
  it('超 20 字截断', async () => {
    const c = await loginAs('set_admin');
    await c.put('/api/settings', { aiLabelText: '一二三四五六七八九十一二三四五六七八九十一二三' });
    expect((await c.get('/api/settings')).body.aiLabelText.length).toBeLessThanOrEqual(20);
  });
});

describe('480P 计费(D-E7)', () => {
  it('480P 比 720P 便宜', () => {
    const c480 = estimateCost(100, '480P');
    const c720 = estimateCost(100, '720P');
    expect(c480).toBeLessThan(c720);
  });
});

describe('Logo 上传安全(5 CRITICAL)', () => {
  it('admin 传 png → 200 + GET 返 orgLogoKey', async () => {
    const c = await loginAs('set_admin');
    const r = await c.postMultipart('/api/settings/logo', {}, { logo: png() });
    expect(r.status).toBe(200);
    expect((await c.get('/api/settings')).body.orgLogoKey).toMatch(/^logos\//);
  });
  it('非 admin → 403', async () => {
    const c = await loginAs('set_viewer');
    const r = await c.postMultipart('/api/settings/logo', {}, { logo: png() });
    expect(r.status).toBe(403);
  });
  it('非图片(pdf)→ 400', async () => {
    const c = await loginAs('set_admin');
    const r = await c.postMultipart('/api/settings/logo', {}, {
      logo: { filename: 'x.pdf', content: Buffer.from('%PDF'), type: 'application/pdf' },
    });
    expect(r.status).toBe(400);
  });
  it('>5MB → 400', async () => {
    const c = await loginAs('set_admin');
    const r = await c.postMultipart('/api/settings/logo', {}, { logo: png(6 * 1024 * 1024) });
    expect(r.status).toBe(400);
  });
  it('缺文件 → 400', async () => {
    const c = await loginAs('set_admin');
    const r = await c.postMultipart('/api/settings/logo', {}, {});
    expect(r.status).toBe(400);
  });
});

describe('Logo 公开读', () => {
  it('已设 logo 的租户 → 返图片字节', async () => {
    const c = await loginAs('set_admin');
    await c.postMultipart('/api/settings/logo', {}, { logo: png() });
    const r = await c.get(`/api/org-logo/${tenantId}`);
    expect(r.status).toBe(200);
  });
  it('未设 logo 的租户 → 404', async () => {
    const t3 = createTenant('无logo台').id;
    const c = new Client(app);
    const r = await c.get(`/api/org-logo/${t3}`);
    expect(r.status).toBe(404);
  });
});
