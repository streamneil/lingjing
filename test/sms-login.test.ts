// 灵镜 短信验证码登录/注册测试 —— /plan-eng-review PR2。
//
// 覆盖:发码(captcha 闸 / 号校验 / 60s 冷却)、统一入口(老号登录 / 新号建机构+admin+试用积分)、
// 验码(错误→次数封顶→作废 / 过期 / purpose 绑定防重放)、哨兵''密码登录拒、停用拦截,
// 以及 REGRESSION(既有用户名密码登录仍正常)。Console sender 无网络可测。

import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';

process.env.DB_FILE = ':memory:';

const { createApp } = await import('../src/server.js');
const { db } = await import('../src/db/index.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { balance } = await import('../src/credits/index.js');
const { hashSmsCode } = await import('../src/auth/crypto.js');
const { _sentCodes } = await import('../src/sms/sender.js');
const { Client } = await import('./helpers.js');

const app = createApp();

async function captchaToken(c: InstanceType<typeof Client>): Promise<string> {
  const ch = await c.get('/api/captcha/challenge');
  const v = await c.post('/api/captcha/verify', { challengeId: ch.body.challengeId, x: ch.body.trackW });
  return v.body.captchaToken;
}
async function sendCode(c: InstanceType<typeof Client>, phone: string) {
  const t = await captchaToken(c);
  return c.post('/api/sms/send', { phone, captchaToken: t });
}
// 直接落一个已知码(绕过发码冷却,专测验码/登录逻辑)。
function putCode(phone: string, code: string, purpose = 'login') {
  db.prepare(`DELETE FROM sms_code WHERE phone=? AND purpose=?`).run(phone, purpose);
  const t = Date.now();
  db.prepare(
    `INSERT INTO sms_code (id,phone,purpose,code_hash,attempts,ip,created_at,expires_at) VALUES (?,?,?,?,0,?,?,?)`,
  ).run(randomUUID(), phone, purpose, hashSmsCode(phone, code), null, t, t + 5 * 60 * 1000);
}

describe('发码 /sms/send', () => {
  it('缺 captcha → 400', async () => {
    const c = new Client(app);
    const r = await c.post('/api/sms/send', { phone: '13800000001' });
    expect(r.status).toBe(400);
  });
  it('非法手机号 → 400(且不消费 captcha)', async () => {
    const c = new Client(app);
    const t = await captchaToken(c);
    const r = await c.post('/api/sms/send', { phone: '123', captchaToken: t });
    expect(r.status).toBe(400);
  });
  it('合法发码 → 200,console sender 收到码', async () => {
    const c = new Client(app);
    const r = await sendCode(c, '13800000002');
    expect(r.status).toBe(200);
    expect(_sentCodes.get('13800000002')).toMatch(/^\d{6}$/);
  });
  it('同号 60s 内再发 → 429 RESEND_COOLDOWN', async () => {
    const c = new Client(app);
    await sendCode(c, '13800000003');
    const r = await sendCode(c, '13800000003');
    expect(r.status).toBe(429);
    expect(r.body.code).toBe('RESEND_COOLDOWN');
    expect(r.body.retryAfter).toBeGreaterThan(0);
  });
});

describe('统一入口 /sms/login', () => {
  it('新手机号 → 注册:建机构 + admin + 试用积分', async () => {
    const phone = '13900000001';
    const c = new Client(app);
    await sendCode(c, phone);
    const code = _sentCodes.get(phone)!;
    const r = await c.post('/api/sms/login', { phone, code });
    expect(r.status).toBe(200);
    expect(r.body.isNew).toBe(true);
    const u = db.prepare(`SELECT * FROM user WHERE phone=?`).get(phone) as any;
    expect(u.role).toBe('admin');
    expect(u.username).toBe(phone);
    expect(u.password_hash).toBe(''); // 哨兵:未设密码
    expect(balance(u.tenant_id)).toBe(200); // 默认试用积分
  });

  it('已有手机号 → 直接登录,不重复建机构', async () => {
    const phone = '13900000002';
    // 先注册一次
    const c1 = new Client(app);
    await sendCode(c1, phone);
    await c1.post('/api/sms/login', { phone, code: _sentCodes.get(phone)! });
    const tenantId = (db.prepare(`SELECT tenant_id FROM user WHERE phone=?`).get(phone) as any).tenant_id;
    const tenantsBefore = (db.prepare(`SELECT COUNT(*) AS n FROM tenant`).get() as any).n;
    // 再次登录(直接落码绕过 60s 冷却)
    putCode(phone, '654321');
    const c2 = new Client(app);
    const r = await c2.post('/api/sms/login', { phone, code: '654321' });
    expect(r.status).toBe(200);
    expect(r.body.isNew).toBe(false);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM tenant`).get() as any).n).toBe(tenantsBefore); // 没多建机构
    expect((db.prepare(`SELECT tenant_id FROM user WHERE phone=?`).get(phone) as any).tenant_id).toBe(tenantId);
  });

  it('验证码错误 → 400;累计 5 次后该码作废', async () => {
    const phone = '13900000003';
    putCode(phone, '111111');
    const c = new Client(app);
    for (let i = 0; i < 5; i++) {
      const r = await c.post('/api/sms/login', { phone, code: '000000' });
      expect(r.status).toBe(400);
    }
    // 第 5 次失败后码已作废 → 即便给对码也失效
    const r = await c.post('/api/sms/login', { phone, code: '111111' });
    expect(r.status).toBe(400);
    expect(db.prepare(`SELECT 1 FROM sms_code WHERE phone=?`).get(phone)).toBeUndefined();
  });

  it('purpose 绑定:reset 码不能当 login 用(防重放)', async () => {
    const phone = '13900000004';
    putCode(phone, '222222', 'reset'); // 只发了 reset 码
    const c = new Client(app);
    const r = await c.post('/api/sms/login', { phone, code: '222222' });
    expect(r.status).toBe(400); // login purpose 查不到 → 已失效
  });

  it('停用用户用验证码登录 → 拒', async () => {
    const t = createTenant('停用测试');
    await createUser(t.id, 'disabled_sms_user', 'pw123456', 'admin');
    const phone = '13900000005';
    db.prepare(`UPDATE user SET phone=?, status='disabled' WHERE username='disabled_sms_user'`).run(phone);
    putCode(phone, '333333');
    const c = new Client(app);
    const r = await c.post('/api/sms/login', { phone, code: '333333' });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('停用');
  });
});

describe('哨兵密码 + 回归', () => {
  it("哨兵'':手机号注册用户走密码登录 → 拒(引导验证码)", async () => {
    const phone = '13900000006';
    const c0 = new Client(app);
    await sendCode(c0, phone);
    await c0.post('/api/sms/login', { phone, code: _sentCodes.get(phone)! }); // 注册(无密码)
    const c = new Client(app);
    const tok = await captchaToken(c);
    const r = await c.post('/api/login', { username: phone, password: 'whatever', captchaToken: tok });
    expect(r.status).toBe(401);
    expect(r.body.error).toContain('未设置密码');
  });

  it('REGRESSION:既有用户名+密码登录仍正常', async () => {
    const t = createTenant('回归测试');
    await createUser(t.id, 'pw_user_ok', 'secret123', 'admin');
    const c = new Client(app);
    const tok = await captchaToken(c);
    const r = await c.post('/api/login', { username: 'pw_user_ok', password: 'secret123', captchaToken: tok });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });
});
