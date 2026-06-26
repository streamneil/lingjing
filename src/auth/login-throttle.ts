// 灵镜 密码登录失败限频(/plan-eng-review,2026-06-26)。
//
// 背景:/login 原本只有 captcha 一道闸。自建滑块 captcha 把答案下发前端、可被脚本绕(GET
// challenge → POST verify 即拿 token),而短信侧有每日上限、密码侧没有 → 密码暴破等于无墙。
// 本模块补真墙:每账号(主闸)+ 每 IP(软信号)窗口内失败超阈值 → 429。复用 sms.ts 的
// RateLimitError + append-only 计数表模式(login_fail_log)。
//
//   POST /login
//     ├─ assertLoginAllowed(ip, user) ──超阈值──► 抛 RateLimitError(API 映射 429)
//     ├─ login() 失败 ─► recordLoginFail(ip, user)        (密码错/停用/未设密码均计,从严)
//     └─ login() 成功 ─► clearLoginFails(ip, user)        (清该账号,免误伤打错后又登对的人)

import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { RateLimitError } from './sms.js';

const now = () => Date.now();

/** 惰性清:超保留期的失败流水(每次校验顺带,免定时 job)。 */
function sweep(): void {
  db.prepare(`DELETE FROM login_fail_log WHERE created_at < ?`).run(now() - config.login.failLogRetentionMs);
}

function countFails(col: 'ip' | 'username', val: string, sinceMs: number): number {
  const r = db
    .prepare(`SELECT COUNT(*) AS n FROM login_fail_log WHERE ${col}=? AND created_at>=?`)
    .get(val, now() - sinceMs) as { n: number };
  return r.n;
}

/** 登录前闸:账号闸优先(针对性穷举单账号),再 IP 闸(跨账号撞库)。超上限抛 RateLimitError。 */
export function assertLoginAllowed(ip: string | null, username: string): void {
  sweep();
  const w = config.login.failWindowMs;
  if (countFails('username', username, w) >= config.login.perAccountFailCap) {
    throw new RateLimitError('登录失败次数过多,请稍后再试', 'LOGIN_FAIL_ACCOUNT');
  }
  if (ip && countFails('ip', ip, w) >= config.login.perIpFailCap) {
    throw new RateLimitError('当前网络登录失败次数过多,请稍后再试', 'LOGIN_FAIL_IP');
  }
}

/** 记一笔登录失败。 */
export function recordLoginFail(ip: string | null, username: string): void {
  db.prepare(`INSERT INTO login_fail_log (id,ip,username,created_at) VALUES (?,?,?,?)`).run(
    randomUUID(), ip, username, now(),
  );
}

/** 登录成功:清该账号的失败计数(打错密码后登对不该被锁)。只按 username 清,不替别人清 IP 行。 */
export function clearLoginFails(_ip: string | null, username: string): void {
  db.prepare(`DELETE FROM login_fail_log WHERE username=?`).run(username);
}
