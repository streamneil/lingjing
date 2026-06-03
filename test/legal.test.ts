// 灵镜 法务/合规测试 —— 条款版本事实源 + 留痕。
//
// 验收:服务条款/隐私政策必须有版本号(可举证),GET /api/legal/version 返回它,
// 且创建 avatar / 克隆 voice 时把当前版本写进 authorization(以后端常量为唯一事实源)。

import { describe, it, expect, beforeEach } from 'vitest';

process.env.DB_FILE = ':memory:';

const { db } = await import('../src/db/index.js');
const { createApp } = await import('../src/server.js');
const { TERMS_VERSION, currentLegalVersion } = await import('../src/legal/index.js');
const { createCustomAvatar } = await import('../src/avatars/index.js');
const { createCloneVoice } = await import('../src/voices/index.js');
const { Client } = await import('./helpers.js');

const app = createApp();
const T = 'legal-tenant';
const U = 'legal-user';

beforeEach(() => {
  db.prepare('DELETE FROM avatar').run();
  db.prepare('DELETE FROM voice').run();
  db.prepare('DELETE FROM authorization').run();
});

describe('条款版本事实源', () => {
  it('TERMS_VERSION 是非空字符串', () => {
    expect(typeof TERMS_VERSION).toBe('string');
    expect(TERMS_VERSION.length).toBeGreaterThan(0);
  });

  it('currentLegalVersion 返回版本 + 条款/隐私链接', () => {
    const v = currentLegalVersion();
    expect(v.version).toBe(TERMS_VERSION);
    expect(v.termsUrl).toBe('/terms.html');
    expect(v.privacyUrl).toBe('/privacy.html');
  });

  it('GET /api/legal/version 公开可读(登录前也能拿版本)', async () => {
    const c = new Client(app);
    const r = await c.get('/api/legal/version');
    expect(r.status).toBe(200);
    expect(r.body.version).toBe(TERMS_VERSION);
  });
});

describe('授权留痕版本(以后端常量为准)', () => {
  it('创建自定义形象 → authorization.terms_version == 后端常量', () => {
    const av = createCustomAvatar({
      tenantId: T, userId: U, name: '台长', kind: 'photo', sourceKey: 'k', consent: true,
    });
    const auth = db.prepare('SELECT * FROM authorization WHERE id=?').get(av.authorization_id) as any;
    expect(auth.terms_version).toBe(TERMS_VERSION);
  });

  it('克隆音色 → authorization.terms_version == 后端常量', () => {
    const v = createCloneVoice({
      tenantId: T, userId: U, name: '台长配音', sourceKey: 'voices/s.wav', consent: true,
    });
    const auth = db.prepare('SELECT * FROM authorization WHERE id=?').get(v.authorization_id) as any;
    expect(auth.terms_version).toBe(TERMS_VERSION);
  });
});
