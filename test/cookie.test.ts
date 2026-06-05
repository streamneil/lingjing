// 灵镜 cookie Secure 标志测试(Docker 部署就绪 D3/C9)。
//
// COOKIE_SECURE env 控:生产(HTTPS via Caddy)带 Secure,本地裸 HTTP 不带(否则登不进)。
// set 和 clear 必须一致(同 Secure),否则浏览器认为是不同 cookie 清不掉。
// 两套 cookie(租户 lj_session / 超管 lj_padmin)都验。

import { describe, it, expect, afterEach } from 'vitest';
import type { Response } from 'express';

process.env.DB_FILE = ':memory:';

const { secureAttr } = await import('../src/auth/cookie.js');
const { setSessionCookie, clearSessionCookie } = await import('../src/auth/middleware.js');
const { setPadminCookie, clearPadminCookie } = await import('../src/auth/platform.js');

// 极简 Response 桩:只抓 setHeader('Set-Cookie', ...)。cookie setter 只用 setHeader,够测。
interface FakeRes { cookie: string; res: Response }
function fakeRes(): FakeRes {
  const holder = { cookie: '' };
  const res = { setHeader(_k: string, v: string) { holder.cookie = v; } } as unknown as Response;
  return { get cookie() { return holder.cookie; }, res };
}

afterEach(() => { delete process.env.COOKIE_SECURE; });

describe('secureAttr() env 控', () => {
  it('COOKIE_SECURE=true → "; Secure"', () => {
    process.env.COOKIE_SECURE = 'true';
    expect(secureAttr()).toBe('; Secure');
  });
  it('不设 → 空串', () => {
    delete process.env.COOKIE_SECURE;
    expect(secureAttr()).toBe('');
  });
  it('其它值(如 false)→ 空串', () => {
    process.env.COOKIE_SECURE = 'false';
    expect(secureAttr()).toBe('');
  });
});

describe('租户 cookie(lj_session)Secure 一致', () => {
  it('COOKIE_SECURE=true:set + clear 都带 Secure', () => {
    process.env.COOKIE_SECURE = 'true';
    const s = fakeRes(); setSessionCookie(s.res, 'tok'); expect(s.cookie).toContain('Secure');
    const c = fakeRes(); clearSessionCookie(c.res); expect(c.cookie).toContain('Secure');
  });
  it('不设:set + clear 都不带 Secure', () => {
    const s = fakeRes(); setSessionCookie(s.res, 'tok'); expect(s.cookie).not.toContain('Secure');
    const c = fakeRes(); clearSessionCookie(c.res); expect(c.cookie).not.toContain('Secure');
  });
});

describe('超管 cookie(lj_padmin)Secure 一致', () => {
  it('COOKIE_SECURE=true:set + clear 都带 Secure', () => {
    process.env.COOKIE_SECURE = 'true';
    const s = fakeRes(); setPadminCookie(s.res, 'tok'); expect(s.cookie).toContain('Secure');
    const c = fakeRes(); clearPadminCookie(c.res); expect(c.cookie).toContain('Secure');
  });
  it('不设:set + clear 都不带 Secure(本地裸 HTTP 超管能登)', () => {
    const s = fakeRes(); setPadminCookie(s.res, 'tok'); expect(s.cookie).not.toContain('Secure');
    const c = fakeRes(); clearPadminCookie(c.res); expect(c.cookie).not.toContain('Secure');
  });
});
