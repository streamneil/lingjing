// 灵镜 账户手机/密码 + 忘记密码测试 —— /plan-eng-review PR3(#7/#8/#9)。
//
// 覆盖:首次设密码(无密码用户,#7)、改密码仍需旧密码(回归)、绑定/换绑手机 + 冲突(#9)、
// 忘记密码重置 + 未绑定静默不发码(#8)。

import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';

process.env.DB_FILE = ':memory:';

const { createApp } = await import('../src/server.js');
const { db } = await import('../src/db/index.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { hashSmsCode } = await import('../src/auth/crypto.js');
const { _sentCodes } = await import('../src/sms/sender.js');
const { smsSendStats } = await import('../src/auth/sms.js');
const { Client } = await import('./helpers.js');

const app = createApp();

async function captchaToken(c: InstanceType<typeof Client>): Promise<string> {
  const ch = await c.get('/api/captcha/challenge');
  const v = await c.post('/api/captcha/verify', { challengeId: ch.body.challengeId, x: ch.body.trackW });
  return v.body.captchaToken;
}
async function smsRegister(c: InstanceType<typeof Client>, phone: string) {
  const t = await captchaToken(c);
  await c.post('/api/sms/send', { phone, captchaToken: t });
  return c.post('/api/sms/login', { phone, code: _sentCodes.get(phone)! });
}
async function pwLogin(c: InstanceType<typeof Client>, username: string, password: string) {
  const t = await captchaToken(c);
  return c.post('/api/login', { username, password, captchaToken: t });
}
function putCode(phone: string, code: string, purpose: string) {
  db.prepare(`DELETE FROM sms_code WHERE phone=? AND purpose=?`).run(phone, purpose);
  const t = Date.now();
  db.prepare(
    `INSERT INTO sms_code (id,phone,purpose,code_hash,attempts,ip,created_at,expires_at) VALUES (?,?,?,?,0,?,?,?)`,
  ).run(randomUUID(), phone, purpose, hashSmsCode(phone, code), null, t, t + 5 * 60 * 1000);
}

describe('首次设密码 / 改密码(#7)', () => {
  it('无密码用户:/me/password 不带旧密码 → 设置成功,之后可密码登录', async () => {
    const phone = '13700000001';
    const c = new Client(app);
    await smsRegister(c, phone); // c 持登录态(哨兵 '' 无密码)
    const r = await c.post('/api/me/password', { newPassword: 'newpass123' });
    expect(r.status).toBe(200);
    expect(r.body.set).toBe(true);
    // 用户名=手机号,可用新密码登录
    const c2 = new Client(app);
    const lr = await pwLogin(c2, phone, 'newpass123');
    expect(lr.status).toBe(200);
  });

  it('已有密码用户:/me/password 不带旧密码 → 400(回归:改密仍需旧密码)', async () => {
    const t = createTenant('改密回归');
    await createUser(t.id, 'haspw_user', 'orig123456', 'admin');
    const c = new Client(app);
    await pwLogin(c, 'haspw_user', 'orig123456');
    const r = await c.post('/api/me/password', { newPassword: 'whatever123' });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('原密码');
  });
});

describe('绑定 / 换绑手机(#9)', () => {
  it('无手机号用户绑定新号 → 成功', async () => {
    const t = createTenant('绑定测试');
    await createUser(t.id, 'bind_user', 'pw12345678', 'creator');
    const c = new Client(app);
    await pwLogin(c, 'bind_user', 'pw12345678');
    const newPhone = '13700000002';
    putCode(newPhone, '111111', 'rebind');
    const r = await c.post('/api/me/phone', { phone: newPhone, code: '111111' });
    expect(r.status).toBe(200);
    const me = await c.get('/api/me');
    expect(me.body.phone).toBe(newPhone);
  });

  it('绑定已被他人占用的手机号 → 发码即 409', async () => {
    const owner = new Client(app);
    await smsRegister(owner, '13700000003'); // 该号已属 owner
    const t = createTenant('冲突测试');
    await createUser(t.id, 'conflict_user', 'pw12345678', 'creator');
    const c = new Client(app);
    await pwLogin(c, 'conflict_user', 'pw12345678');
    const r = await c.post('/api/me/phone/send', { phone: '13700000003' });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain('已被其他账号绑定');
  });

  it('未登录不能绑定手机 → 401', async () => {
    const c = new Client(app);
    const r = await c.post('/api/me/phone', { phone: '13700000004', code: '111111' });
    expect(r.status).toBe(401);
  });
});

describe('忘记密码(#8)', () => {
  it('绑定手机号:验码 → 重置密码 → 可用新密码登录', async () => {
    const phone = '13700000005';
    const c0 = new Client(app);
    await smsRegister(c0, phone); // 注册(无密码)
    putCode(phone, '654321', 'reset');
    const c = new Client(app);
    const r = await c.post('/api/sms/forgot', { phone, code: '654321', newPassword: 'reset123456' });
    expect(r.status).toBe(200);
    const c2 = new Client(app);
    const lr = await pwLogin(c2, phone, 'reset123456');
    expect(lr.status).toBe(200);
  });

  it('未绑定手机号请求 reset 码 → 静默成功,不落码(不泄露存在性)', async () => {
    const phone = '13700009999'; // 没注册过
    const c = new Client(app);
    const t = await captchaToken(c);
    const r = await c.post('/api/sms/send', { phone, captchaToken: t, purpose: 'reset' });
    expect(r.status).toBe(200); // 静默 ok
    expect(db.prepare(`SELECT 1 FROM sms_code WHERE phone=? AND purpose='reset'`).get(phone)).toBeUndefined();
  });

  it('错误验证码重置 → 400', async () => {
    const phone = '13700000006';
    const c0 = new Client(app);
    await smsRegister(c0, phone);
    putCode(phone, '222222', 'reset');
    const c = new Client(app);
    const r = await c.post('/api/sms/forgot', { phone, code: '000000', newPassword: 'reset123456' });
    expect(r.status).toBe(400);
  });
});

describe('短信监控聚合(E5)', () => {
  it('smsSendStats 返回按天/手机号脱敏聚合,total.sends>0', async () => {
    const phone = '13700007777';
    const c = new Client(app);
    const t = await captchaToken(c);
    await c.post('/api/sms/send', { phone, captchaToken: t });
    const s = smsSendStats(30);
    expect(s.total.sends).toBeGreaterThan(0);
    expect(s.byDay.length).toBeGreaterThan(0);
    expect(s.topPhones.some((p) => p.phone.includes('****'))).toBe(true); // 手机号脱敏
  });
});
