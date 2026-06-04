// 灵镜 形象上传 API 测试(mock MinIO,验证 multipart + 授权强制 + RBAC)。

import { describe, it, expect, beforeAll, vi } from 'vitest';

process.env.DB_FILE = ':memory:';

// mock 存储,避免连真实 MinIO
vi.mock('../src/storage/index.js', () => ({
  putObject: vi.fn(async (k: string) => k),
  getSignedUrl: vi.fn(async (k: string) => 'signed://' + k),
  storage: { putObject: vi.fn(async (k: string) => k), getSignedUrl: vi.fn(async (k: string) => k) },
}));

const { createApp } = await import('../src/server.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { Client } = await import('./helpers.js');

const app = createApp();
let tenantId: string;

beforeAll(() => {
  tenantId = createTenant('形象测试台').id;
  createUser(tenantId, 'creator', 'pw123456', 'creator');
  createUser(tenantId, 'viewer', 'pw123456', 'viewer');
});

async function loginAs(username: string) {
  const c = new Client(app);
  await c.login(username, 'pw123456');
  return c;
}

const fakePhoto = { filename: 'face.jpg', content: Buffer.from('fakejpegdata'), type: 'image/jpeg' };

describe('形象上传 API', () => {
  it('列表含预置形象', async () => {
    const c = await loginAs('creator');
    const r = await c.get('/api/avatars');
    expect(r.status).toBe(200);
    expect(r.body.presets.length).toBeGreaterThan(0);
    expect(Array.isArray(r.body.custom)).toBe(true);
  });

  it('未勾授权 → 400(合规门票)', async () => {
    const c = await loginAs('creator');
    const r = await c.postMultipart('/api/avatars', { name: '台长', consent: 'false' }, { photo: fakePhoto });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('授权');
  });

  it('缺照片 → 400', async () => {
    const c = await loginAs('creator');
    const r = await c.postMultipart('/api/avatars', { name: '台长', consent: 'true' }, {});
    expect(r.status).toBe(400);
  });

  it('勾授权 + 有照片 → 201,且出现在列表', async () => {
    const c = await loginAs('creator');
    const r = await c.postMultipart('/api/avatars', { name: '台长专属', consent: 'true' }, { photo: fakePhoto });
    expect(r.status).toBe(201);
    expect(r.body.id).toBeTruthy();
    const list = await c.get('/api/avatars');
    expect(list.body.custom.some((a: any) => a.name === '台长专属')).toBe(true);
  });

  it('viewer 不能上传形象 → 403', async () => {
    const c = await loginAs('viewer');
    const r = await c.postMultipart('/api/avatars', { name: 'x', consent: 'true' }, { photo: fakePhoto });
    expect(r.status).toBe(403);
  });

  it('C6:重命名 + 设为默认', async () => {
    const c = await loginAs('creator');
    const created = await c.postMultipart('/api/avatars', { name: '原名', consent: 'true' }, { photo: fakePhoto });
    const id = created.body.id;
    // 重命名
    const rn = await c.put('/api/avatars/' + id, { name: '台长专属' });
    expect(rn.status).toBe(200);
    // 设为默认
    const def = await c.post('/api/avatars/' + id + '/default');
    expect(def.status).toBe(200);
    const list = await c.get('/api/avatars');
    const mine = list.body.custom.find((a: any) => a.id === id);
    expect(mine.name).toBe('台长专属');
    expect(mine.isDefault).toBe(true);
  });

  it('列表预置含 gender/orientation(C5 筛选用)', async () => {
    const c = await loginAs('creator');
    const r = await c.get('/api/avatars');
    expect(r.body.presets.length).toBeGreaterThanOrEqual(6);
    expect(r.body.presets[0].gender).toBeTruthy();
    expect(r.body.presets[0].orientation).toBeTruthy();
  });
});
