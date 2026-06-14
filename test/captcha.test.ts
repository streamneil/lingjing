// 灵镜 滑块行为验证测试 —— 出题、位置比对、token 一次性。
//
// 决策来源:/plan-ceo-review D8/D9 —— 服务端发一次性 token,真挡无头脚本。

import { describe, it, expect } from 'vitest';

process.env.DB_FILE = ':memory:';

const { createApp } = await import('../src/server.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { Client } = await import('./helpers.js');

const app = createApp();

describe('滑块 challenge / verify(拖到底式)', () => {
  it('出题返回 challengeId + trackW', async () => {
    const c = new Client(app);
    const r = await c.get('/api/captcha/challenge');
    expect(r.status).toBe(200);
    expect(typeof r.body.challengeId).toBe('string');
    expect(typeof r.body.trackW).toBe('number');
  });

  it('拖到末端(x=trackW)→ 发 captchaToken', async () => {
    const c = new Client(app);
    const ch = await c.get('/api/captcha/challenge');
    const v = await c.post('/api/captcha/verify', { challengeId: ch.body.challengeId, x: ch.body.trackW });
    expect(v.status).toBe(200);
    expect(v.body.ok).toBe(true);
    expect(typeof v.body.captchaToken).toBe('string');
  });

  it('没拖到底(x 远小于 trackW)→ 400', async () => {
    const c = new Client(app);
    const ch = await c.get('/api/captcha/challenge');
    const v = await c.post('/api/captcha/verify', { challengeId: ch.body.challengeId, x: Math.floor(ch.body.trackW / 2) });
    expect(v.status).toBe(400);
  });

  it('challenge 一次性:同 challengeId 再 verify → 400', async () => {
    const c = new Client(app);
    const ch = await c.get('/api/captcha/challenge');
    await c.post('/api/captcha/verify', { challengeId: ch.body.challengeId, x: ch.body.trackW }); // 第一次成功（消费 challenge）
    const again = await c.post('/api/captcha/verify', { challengeId: ch.body.challengeId, x: ch.body.trackW });
    expect(again.status).toBe(400); // challenge 已删
  });
});

describe('captcha_token 一次性（登录场景）', () => {
  it('同一 token 登录两次:第二次 400（token 用过即弃）', async () => {
    const tenantId = createTenant('滑块台').id;
    await createUser(tenantId, 'capuser', 'pw123456', 'creator');
    // 手动走一遍:challenge → verify 拿 token → 用同一 token 登录两次
    const c = new Client(app);
    const ch = await c.get('/api/captcha/challenge');
    const v = await c.post('/api/captcha/verify', { challengeId: ch.body.challengeId, x: ch.body.trackW });
    const token = v.body.captchaToken;
    const first = await c.post('/api/login', { username: 'capuser', password: 'pw123456', captchaToken: token });
    expect(first.status).toBe(200);
    const second = await c.post('/api/login', { username: 'capuser', password: 'pw123456', captchaToken: token });
    expect(second.status).toBe(400); // token 已消费
  });

  it('无 captchaToken 登录 → 400', async () => {
    const tenantId = createTenant('滑块台2').id;
    await createUser(tenantId, 'capuser2', 'pw123456', 'creator');
    const c = new Client(app);
    const r = await c.post('/api/login', { username: 'capuser2', password: 'pw123456' });
    expect(r.status).toBe(400);
  });
});
