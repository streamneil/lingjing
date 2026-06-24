// 灵镜 短信验证码服务 — 发码 / 验码 / 限频(/plan-ceo-review + /plan-eng-review,2026-06-24)。
//
// 设计要点:
//  - 验证码 6 位、5min 有效(code-TTL)≠ 重发冷却 60s(resend-cooldown),两者独立概念。
//  - 单活码:每 (phone,purpose) 只保留最新一条(sms_code UNIQUE(phone,purpose),发码前 DELETE 旧)。
//  - 不落明文:存 sha256(phone:code);验码重算比对。
//  - 验码 ≤5 次失败即作废(6 位防暴破,需求#4)+ 每 IP 日验证失败上限(防跨手机号穷举,外部声音补)。
//  - 限频计数走独立 append-only sms_send_log(sms_code 消费即删会丢计数);保留 30 天惰性清。
//  - consumeSmsCode 同步,供鉴权事务内「验码 + 特权副作用」原子化(防 login 码当 register 重放)。

import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import { config } from './../config.js';
import { genNumericCode, hashSmsCode } from './crypto.js';
import { smsSender } from '../sms/sender.js';

const now = () => Date.now();
// 统一入口:'login' 同时覆盖登录与新号注册(verify 时按手机号是否存在分支,需求#5/#6),
// 故无独立 'register'(外部声音:不建未用的枚举值)。'reset' 忘密、'rebind' 绑定手机(PR3)。
export type SmsPurpose = 'login' | 'reset' | 'rebind';
const VERIFY_FAIL = 'verify_fail'; // sms_send_log 中标记验证失败行(与发送行区分)

export type RateLimitCode = 'RESEND_COOLDOWN' | 'PHONE_DAILY' | 'IP_DAILY' | 'IP_VERIFY_FAIL' | 'BAD_PHONE';
export class RateLimitError extends Error {
  constructor(message: string, public readonly code: RateLimitCode, public readonly retryAfterSec?: number) {
    super(message);
    this.name = 'RateLimitError';
  }
}

/** 中国大陆手机号校验(11 位,1 开头,第二位 3-9)。返回规范化号;非法抛 RateLimitError(BAD_PHONE)。 */
export function normalizePhone(raw: unknown): string {
  const p = typeof raw === 'string' ? raw.replace(/[\s-]/g, '') : '';
  if (!/^1[3-9]\d{9}$/.test(p)) throw new RateLimitError('请输入有效的手机号', 'BAD_PHONE');
  return p;
}

/** 脱敏:138****8888(成员列表/日志展示用)。 */
export function maskPhone(p: string | null | undefined): string {
  if (!p || p.length !== 11) return p ?? '';
  return `${p.slice(0, 3)}****${p.slice(7)}`;
}

/** 惰性清理:过期验证码 + 超 30 天发送流水(每次发码/验码顺带,免定时 job)。 */
function sweep(): void {
  const t = now();
  db.prepare(`DELETE FROM sms_code WHERE expires_at < ?`).run(t);
  db.prepare(`DELETE FROM sms_send_log WHERE created_at < ?`).run(t - config.sms.sendLogRetentionMs);
}

function countSends(col: 'phone' | 'ip', val: string, sinceMs: number): number {
  const r = db
    .prepare(`SELECT COUNT(*) AS n FROM sms_send_log WHERE ${col}=? AND purpose!=? AND created_at>=?`)
    .get(val, VERIFY_FAIL, now() - sinceMs) as { n: number };
  return r.n;
}

/** 发码:限频校验 → 发短信(await)→ 成功后落单活码 + 记发送流水。
 *  顺序「先发后落」:发失败不落码不占冷却,用户可立即重试。限频/发送失败各自抛错。 */
export async function sendSmsCode(phone: string, purpose: SmsPurpose, ip: string | null): Promise<void> {
  sweep();
  const DAY = 24 * 60 * 60 * 1000;
  // 1) 同手机号 60s 冷却(需求#3)
  const last = db
    .prepare(`SELECT created_at FROM sms_send_log WHERE phone=? AND purpose!=? ORDER BY created_at DESC LIMIT 1`)
    .get(phone, VERIFY_FAIL) as { created_at: number } | undefined;
  if (last) {
    const elapsed = now() - last.created_at;
    if (elapsed < config.sms.resendCooldownMs) {
      throw new RateLimitError('发送过于频繁,请稍后再试', 'RESEND_COOLDOWN', Math.ceil((config.sms.resendCooldownMs - elapsed) / 1000));
    }
  }
  // 2) 每手机号日上限(主闸)
  if (countSends('phone', phone, DAY) >= config.sms.perPhoneDailyCap) {
    throw new RateLimitError('该手机号今日获取验证码次数过多,请明天再试', 'PHONE_DAILY');
  }
  // 3) 每 IP 日上限(软信号,政企 NAT 放宽)
  if (ip && countSends('ip', ip, DAY) >= config.sms.perIpDailyCap) {
    throw new RateLimitError('当前网络今日获取验证码次数过多,请稍后再试', 'IP_DAILY');
  }

  const code = genNumericCode(6);
  await smsSender().sendCode(phone, code, purpose); // 失败抛 SmsSendError(API 层映射 + 记日志)

  const t = now();
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM sms_code WHERE phone=? AND purpose=?`).run(phone, purpose); // 单活:旧码作废
    db.prepare(
      `INSERT INTO sms_code (id,phone,purpose,code_hash,attempts,ip,created_at,expires_at) VALUES (?,?,?,?,0,?,?,?)`,
    ).run(randomUUID(), phone, purpose, hashSmsCode(phone, code), ip, t, t + config.sms.codeTtlMs);
    db.prepare(`INSERT INTO sms_send_log (id,phone,ip,purpose,created_at) VALUES (?,?,?,?,?)`).run(
      randomUUID(), phone, ip, purpose, t,
    );
  });
  tx();
}

/** 验码前闸:每 IP 日验证失败上限(防跨手机号穷举 6 位码)。供 API 在调鉴权流程前调用。 */
export function assertVerifyAllowed(ip: string | null): void {
  if (!ip) return;
  sweep();
  const DAY = 24 * 60 * 60 * 1000;
  const r = db
    .prepare(`SELECT COUNT(*) AS n FROM sms_send_log WHERE ip=? AND purpose=? AND created_at>=?`)
    .get(ip, VERIFY_FAIL, now() - DAY) as { n: number };
  if (r.n >= config.sms.perIpVerifyFailDailyCap) {
    throw new RateLimitError('验证失败次数过多,请稍后再试', 'IP_VERIFY_FAIL');
  }
}

export type ConsumeResult = 'ok' | 'expired' | 'wrong' | 'too_many' | 'none';

/** 验码并消费(同步,供鉴权事务内调用)。
 *  绑定 (phone,purpose):login 码当 register 用 → 查不到 → 'none'(防重放)。
 *  'ok' → 删除该码(一次性);'wrong' → attempts++,达上限即作废 + 记 IP 验证失败流水。 */
export function consumeSmsCode(phone: string, purpose: SmsPurpose, code: string, ip: string | null): ConsumeResult {
  const row = db
    .prepare(`SELECT id, code_hash, attempts, expires_at FROM sms_code WHERE phone=? AND purpose=?`)
    .get(phone, purpose) as { id: string; code_hash: string; attempts: number; expires_at: number } | undefined;
  if (!row) return 'none';
  if (row.expires_at < now()) {
    db.prepare(`DELETE FROM sms_code WHERE id=?`).run(row.id);
    return 'expired';
  }
  if (row.code_hash === hashSmsCode(phone, code)) {
    db.prepare(`DELETE FROM sms_code WHERE id=?`).run(row.id); // 一次性,验过即弃
    return 'ok';
  }
  // 验错:记 IP 失败流水(穷举闸)+ attempts++,达上限作废该码(逼用户重新获取)。
  db.prepare(`INSERT INTO sms_send_log (id,phone,ip,purpose,created_at) VALUES (?,?,?,?,?)`).run(
    randomUUID(), phone, ip, VERIFY_FAIL, now(),
  );
  const attempts = row.attempts + 1;
  if (attempts >= config.sms.maxVerifyAttempts) {
    db.prepare(`DELETE FROM sms_code WHERE id=?`).run(row.id);
    return 'too_many';
  }
  db.prepare(`UPDATE sms_code SET attempts=? WHERE id=?`).run(attempts, row.id);
  return 'wrong';
}

/** consume 结果 → 用户可见错误文案(不泄露剩余次数)。'ok' 返 null。 */
export function consumeMessage(r: ConsumeResult): string | null {
  switch (r) {
    case 'ok': return null;
    case 'expired': return '验证码已过期,请重新获取';
    case 'too_many': return '验证码尝试过多,请重新获取';
    case 'none': return '验证码已失效,请重新获取';
    case 'wrong': return '验证码错误';
  }
}

/** 超管只读:近 N 天短信发送量(按天/按 IP/按手机号脱敏聚合)。E5 视图用。 */
export function smsSendStats(days = 30): {
  byDay: { day: string; sends: number; fails: number }[];
  topIps: { ip: string; sends: number }[];
  topPhones: { phone: string; sends: number }[];
  total: { sends: number; fails: number };
} {
  const since = now() - days * 24 * 60 * 60 * 1000;
  const rows = db
    .prepare(`SELECT phone, ip, purpose, created_at FROM sms_send_log WHERE created_at>=?`)
    .all(since) as { phone: string; ip: string | null; purpose: string | null; created_at: number }[];
  const byDayMap = new Map<string, { sends: number; fails: number }>();
  const ipMap = new Map<string, number>();
  const phoneMap = new Map<string, number>();
  let sends = 0, fails = 0;
  for (const r of rows) {
    const isFail = r.purpose === VERIFY_FAIL;
    const day = new Date(r.created_at).toISOString().slice(0, 10);
    const d = byDayMap.get(day) ?? { sends: 0, fails: 0 };
    if (isFail) { d.fails++; fails++; } else {
      d.sends++; sends++;
      if (r.ip) ipMap.set(r.ip, (ipMap.get(r.ip) ?? 0) + 1);
      phoneMap.set(r.phone, (phoneMap.get(r.phone) ?? 0) + 1);
    }
    byDayMap.set(day, d);
  }
  const top = (m: Map<string, number>, k: string) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([key, n]) => ({ [k]: key, sends: n }));
  return {
    byDay: [...byDayMap.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([day, v]) => ({ day, ...v })),
    topIps: top(ipMap, 'ip') as { ip: string; sends: number }[],
    topPhones: ([...phoneMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
      .map(([phone, n]) => ({ phone: maskPhone(phone), sends: n }))),
    total: { sends, fails },
  };
}
