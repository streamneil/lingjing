// 灵镜 认证基元 — bcrypt 密码 hash/校验 + 随机 token 生成。
//
// 决策来源:/plan-eng-review E-2.1 —— 租户认证(auth/index.ts)与平台超管认证
// (auth/platform.ts)的 bcrypt+token 逻辑同构。抽公共助手消除重复(DRY),
// 但两套 session 表语义不同(session / platform_session),各自查表不强合泛型。
//
// 改 bcrypt rounds / token 长度只此一处,两边自动一致。

import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';

const BCRYPT_ROUNDS = 10;

/** bcrypt hash 明文密码(同步,Slice 单机够)。 */
export function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, BCRYPT_ROUNDS);
}

/** 校验明文密码与 hash 是否匹配。 */
export function verifyPassword(plain: string, hash: string): boolean {
  return bcrypt.compareSync(plain, hash);
}

/** 抵消时序差异:对不存在的用户也跑一次 compare,避免"用户是否存在"被时序泄露。 */
export function dummyVerify(plain: string): void {
  bcrypt.compareSync(plain, '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinv');
}

/** 生成不可猜的随机 token(session token / captcha token 共用)。 */
export function genToken(): string {
  return randomBytes(32).toString('hex');
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
