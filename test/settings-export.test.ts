// 灵镜 设置 + 导出 + 预警 API 测试。

import { describe, it, expect, beforeAll } from 'vitest';

process.env.DB_FILE = ':memory:';

const { createApp } = await import('../src/server.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { grant } = await import('../src/credits/index.js');
const { Client } = await import('./helpers.js');

const app = createApp();
let tenantId: string;

beforeAll(async () => {
  tenantId = createTenant('设置测试台').id;
  await createUser(tenantId, 'setadmin', 'pw123456', 'admin'); // 不能用保留字 admin(T7)
  // 原 setviewer(viewer):viewer 已废弃 → 建为 creator。settings 读 requireAuth(creator 可读),
  // 写 admin-only(creator 被拒 403)→ "非 admin 可读不可改" 的意图不变。
  await createUser(tenantId, 'setviewer', 'pw123456', 'creator');
});

async function loginAs(u: string) {
  const c = new Client(app);
  await c.login(u, 'pw123456');
  return c;
}

describe('个人信息 + 改密码', () => {
  it('/me 含 displayName(默认=用户名)', async () => {
    const c = await loginAs('setadmin');
    const me = await c.get('/api/me');
    expect(me.body.username).toBe('setadmin');
    expect(me.body.displayName).toBe('setadmin');
  });
  it('改昵称生效', async () => {
    const c = await loginAs('setadmin');
    const r = await c.put('/api/me', { displayName: '台长' });
    expect(r.status).toBe(200);
    expect((await c.get('/api/me')).body.displayName).toBe('台长');
  });
  it('改密码:原密码错 → 400', async () => {
    const c = await loginAs('setviewer');
    const r = await c.post('/api/me/password', { oldPassword: '错的', newPassword: 'newpw123' });
    expect(r.status).toBe(400);
  });
  it('改密码:成功后新密码可登录、旧密码失效', async () => {
    // 单独建一个用户避免影响其它用例
    await createUser(tenantId, 'pwuser', 'oldpw123', 'creator');
    const c = new Client(app);
    await c.login('pwuser', 'oldpw123');
    const r = await c.post('/api/me/password', { oldPassword: 'oldpw123', newPassword: 'newpw456' });
    expect(r.status).toBe(200);
    // 新密码能登录
    const c2 = new Client(app);
    const ok = await c2.login('pwuser', 'newpw456');
    expect(ok.status).toBe(200);
    // 旧密码失效
    const c3 = new Client(app);
    const bad = await c3.login('pwuser', 'oldpw123');
    expect(bad.status).toBe(401);
  });
});

describe('系统设置', () => {
  it('读设置返回默认值', async () => {
    const c = await loginAs('setadmin');
    const r = await c.get('/api/settings');
    expect(r.status).toBe(200);
    expect(r.body.delivery).toBe('hosted');
    expect(r.body.aiLabelEnabled).toBe(true);
  });

  it('交付模式只读:admin 传 delivery → 400(不可运行时改)', async () => {
    const c = await loginAs('setadmin');
    const put = await c.put('/api/settings', { delivery: 'private' });
    expect(put.status).toBe(400); // 交付模式部署时定,后端拒绝运行时修改
    expect(put.body.code).toBe('DELIVERY_READONLY');
  });

  // 系统名称可改、机构名称只读(租户品牌 T1)—— 详尽覆盖见 settings-branding.test.ts。
  it('系统名称可改:admin 传 brandName → 200 并生效;机构名 orgName 不变', async () => {
    const c = await loginAs('setadmin');
    const orgName0 = (await c.get('/api/settings')).body.orgName;
    const put = await c.put('/api/settings', { brandName: '改名后的台' });
    expect(put.status).toBe(200);
    const s = (await c.get('/api/settings')).body;
    expect(s.brandName).toBe('改名后的台'); // 系统名生效
    expect(s.orgName).toBe(orgName0); // 机构名(身份)不变
  });

  it('admin 改默认分辨率 → 读回生效(可改的设置仍生效)', async () => {
    const c = await loginAs('setadmin');
    const put = await c.put('/api/settings', { defaultResolution: '480P' });
    expect(put.status).toBe(200);
    expect((await c.get('/api/settings')).body.defaultResolution).toBe('480P');
  });

  it('非 admin 可读但不能改设置 → 403', async () => {
    const c = await loginAs('setviewer');
    expect((await c.get('/api/settings')).status).toBe(200); // 非 admin 可读
    const put = await c.put('/api/settings', { defaultResolution: '720P' });
    expect(put.status).toBe(403); // 非 admin 不能改(requireRole 先于 body 校验)
  });
});

describe('消费记录导出 + 预警', () => {
  it('CSV 导出返回 text/csv', async () => {
    const c = await loginAs('setadmin');
    grant(tenantId, 500);
    const r = await c.get('/api/credits/ledger.csv');
    expect(r.status).toBe(200);
    // body 是 CSV 文本(含表头中文)
    expect(typeof r.body === 'string' ? r.body : JSON.stringify(r.body)).toContain('时间');
  });

  it('余额预警:发放后不低,余额阈值字段存在', async () => {
    const c = await loginAs('setadmin');
    const r = await c.get('/api/credits/warning');
    expect(r.status).toBe(200);
    expect(typeof r.body.low).toBe('boolean');
    expect(r.body.threshold).toBeGreaterThan(0);
  });
});
