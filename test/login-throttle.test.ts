// 灵镜 — 密码登录失败限频(/login 暴破真墙;/plan-eng-review 2026-06-26)。
//
// 覆盖:
//   - 每账号失败达上限 → 429 LOGIN_FAIL_ACCOUNT(captcha 之外的真墙)
//   - 登录成功清该账号失败计数(打错后登对不被锁)
//   - 账号隔离:A 被锁不影响 B(同 IP 下 B 仍可登,未到 IP 上限)

import { describe, it, expect, beforeAll } from 'vitest';

process.env.DB_FILE = ':memory:';

const { createApp } = await import('../src/server.js');
const { createTenant, createUser } = await import('../src/auth/index.js');
const { Client } = await import('./helpers.js');

const app = createApp();

beforeAll(async () => {
  const t = createTenant('限频测试台');
  await createUser(t.id, 'pwuser', 'pw123456', 'admin');
  await createUser(t.id, 'pwuser2', 'pw123456', 'admin');
});

// 每次新 Client(独立 cookie),login 助手自动过滑块再 POST /login。
function attempt(username: string, password: string) {
  return new Client(app).login(username, password);
}

describe('密码登录失败限频(/login)', () => {
  it('连续失败达每账号上限(10)→ 之后 429 LOGIN_FAIL_ACCOUNT', async () => {
    for (let i = 0; i < 10; i++) {
      const r = await attempt('pwuser', 'wrong' + i);
      expect(r.status).toBe(401); // 前 10 次:密码错
    }
    const blocked = await attempt('pwuser', 'wrongX');
    expect(blocked.status).toBe(429); // 第 11 次:限频拦截
    expect(blocked.body.code).toBe('LOGIN_FAIL_ACCOUNT');
  });

  it('登录成功清该账号失败计数(打错后登对不被锁)', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await attempt('pwuser2', 'bad' + i)).status).toBe(401); // 错 5 次(未达上限)
    }
    expect((await attempt('pwuser2', 'pw123456')).status).toBe(200); // 登对 → 清零
    for (let i = 0; i < 5; i++) {
      expect((await attempt('pwuser2', 'bad' + i)).status).toBe(401); // 清零后再错 5 次仍不锁
    }
    expect((await attempt('pwuser2', 'pw123456')).status).toBe(200);
  });

  it('账号隔离:A 被锁,B 仍可登', async () => {
    expect((await attempt('pwuser', 'x')).status).toBe(429); // A 仍在锁定窗口内
    expect((await attempt('pwuser2', 'pw123456')).status).toBe(200); // B 不受影响
  });
});
