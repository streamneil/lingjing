// 灵镜 认证基元 — bcrypt 密码 hash/校验 + 随机 token 生成。
//
// 决策来源:/plan-eng-review E-2.1 —— 租户认证(auth/index.ts)与平台超管认证
// (auth/platform.ts)的 bcrypt+token 逻辑同构。抽公共助手消除重复(DRY),
// 但两套 session 表语义不同(session / platform_session),各自查表不强合泛型。
//
// 改 bcrypt rounds / token 长度只此一处,两边自动一致。
//
// 并发决策(/qa 压测):改用原生 bcrypt 的【异步】API。原 bcryptjs(纯 JS)+ *Sync
// 会阻塞事件循环 —— 一次 compare ~57ms 期间全服务(读/写/所有用户)冻结,登录因此
// 封顶 ~17 RPS 且加并发不涨。原生 bcrypt 异步把哈希放进 libuv 线程池,跨核并行:
// 实测 20 并发登录 1097ms→261ms(18→77 logins/s,4.3×)且不再冻结读写。
// hash 格式仍为 $2b$,与历史 bcryptjs 存量 hash 双向兼容,无需迁移密码。

import { randomBytes, createHash } from 'node:crypto';
import bcrypt from 'bcrypt';

const BCRYPT_ROUNDS = 10;

/** bcrypt hash 明文密码(异步,跑在 libuv 线程池,不阻塞事件循环)。 */
export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

/** 校验明文密码与 hash 是否匹配(异步,不阻塞事件循环)。 */
export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/** 抵消时序差异:对不存在的用户也跑一次 compare,避免"用户是否存在"被时序泄露。 */
export function dummyVerify(plain: string): Promise<boolean> {
  return bcrypt.compare(plain, '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinv');
}

/** 生成不可猜的随机 token(session token / captcha token 共用)。 */
export function genToken(): string {
  return randomBytes(32).toString('hex');
}

// ── Open API key(lj_sk_…)──
// 自家 API key 只需单向哈希(不像第三方 provider key 要解密回来),故用 SHA-256 不用 AES。
// key = lj_sk_ + 32 字节随机 hex;明文仅创建时回传一次,库里只存 sha256(key)。
export const API_KEY_PREFIX = 'lj_sk_';
/** 生成 API key。返回明文 + 展示前缀(前 12 位)。明文不落库,仅创建时回传。 */
export function genApiKey(): { key: string; prefix: string } {
  const key = API_KEY_PREFIX + randomBytes(32).toString('hex');
  return { key, prefix: key.slice(0, 12) };
}
/** API key 单向哈希(sha256 hex);认证时重算比对。 */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

// 临时密码字符集:去掉易混淆字符(0/O、1/l/I)+ 安全符号子集,管理员口头/复制传达不歧义。
const TMP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789@#%*';
/** 生成 12 位随机强密码(crypto 随机源,无歧义字符)。管理员重置成员密码用,明文仅回传一次。 */
export function genTempPassword(len = 12): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += TMP_ALPHABET[bytes[i]! % TMP_ALPHABET.length];
  return out;
}

// ── 短信验证码(SMS OTP)──
// 决策来源:/plan-ceo-review(6 位,覆盖原 4 位需求)+ /plan-eng-review。
// 用 crypto 随机源取均匀 6 位数字(不用 Math.random,且避免取模偏置:拒绝采样)。
/** 生成 6 位纯数字验证码(crypto 随机,均匀分布,允许前导零)。 */
export function genNumericCode(len = 6): string {
  let out = '';
  while (out.length < len) {
    for (const b of randomBytes(len)) {
      if (b < 250) { out += String(b % 10); if (out.length === len) break; } // 250..255 丢弃,消除取模偏置
    }
  }
  return out;
}

/** 验证码不落明文:存 sha256(phone:code)。验证时重算比对(快、无 bcrypt 开销;OTP 短时一次性,sha256 足够)。 */
export function hashSmsCode(phone: string, code: string): string {
  return createHash('sha256').update(`${phone}:${code}`).digest('hex');
}
