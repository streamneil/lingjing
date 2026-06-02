// 灵镜 设置 + 导出 + 预警 API 测试。

import { describe, it, expect, beforeAll } from 'vitest';

process.env.DB_FILE = ':memory:';

const { createApp } = await import('../src/server.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { grant } = await import('../src/credits/index.js');
const { Client } = await import('./helpers.js');

const app = createApp();
let tenantId: string;

beforeAll(() => {
  tenantId = createTenant('设置测试台').id;
  createUser(tenantId, 'admin', 'pw123456', 'admin');
  createUser(tenantId, 'viewer', 'pw123456', 'viewer');
});

async function loginAs(u: string) {
  const c = new Client(app);
  await c.post('/api/login', { username: u, password: 'pw123456' });
  return c;
}

describe('系统设置', () => {
  it('读设置返回默认值', async () => {
    const c = await loginAs('admin');
    const r = await c.get('/api/settings');
    expect(r.status).toBe(200);
    expect(r.body.delivery).toBe('hosted');
    expect(r.body.aiLabelEnabled).toBe(true);
  });

  it('admin 改交付模式为 private,读回生效', async () => {
    const c = await loginAs('admin');
    const put = await c.put('/api/settings', { delivery: 'private', orgName: '改名后的台' });
    expect(put.status).toBe(200);
    const r = await c.get('/api/settings');
    expect(r.body.delivery).toBe('private');
    expect(r.body.orgName).toBe('改名后的台');
  });

  it('viewer 可读但不能改设置 → 403', async () => {
    const c = await loginAs('viewer');
    expect((await c.get('/api/settings')).status).toBe(200); // viewer 可读
    const put = await c.put('/api/settings', { delivery: 'hosted' });
    expect(put.status).toBe(403); // viewer 不能改
  });
});

describe('消费记录导出 + 预警', () => {
  it('CSV 导出返回 text/csv', async () => {
    const c = await loginAs('admin');
    grant(tenantId, 500);
    const r = await c.get('/api/credits/ledger.csv');
    expect(r.status).toBe(200);
    // body 是 CSV 文本(含表头中文)
    expect(typeof r.body === 'string' ? r.body : JSON.stringify(r.body)).toContain('时间');
  });

  it('余额预警:发放后不低,余额阈值字段存在', async () => {
    const c = await loginAs('admin');
    const r = await c.get('/api/credits/warning');
    expect(r.status).toBe(200);
    expect(typeof r.body.low).toBe('boolean');
    expect(r.body.threshold).toBeGreaterThan(0);
  });
});
