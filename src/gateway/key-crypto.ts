// 灵镜 — Provider API Key 加密基元(AES-256-GCM)。纯函数,无 db/config 依赖(叶子模块,防环)。
//
// 决策来源:/plan-ceo-review + /plan-eng-review 2026-06-16-model-access-platform(PR-1)。
// 各厂商模型 key 原在 .env 易泄露 → 加密存库。主密钥 MASTER_KEY 走环境变量(不进库不进 git)。
//
// 安全要点(eng 外部声音 P4):
//  - AES-256-GCM:认证加密,tag 防篡改。
//  - AAD = provider.id:把密文绑定到行,防止把 provider A 的密文拷到 provider B 行仍能解(行间搬移)。
//  - key_version:轮转主密钥时密文带版本,轮转脚本可分批/断点续;新旧混合可辨。
//  - admin 永不见明文:只回显 last4;解密只在网关调用时发生。
//
// MASTER_KEY 生成:openssl rand -base64 32  (32 字节 = AES-256)。

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

export const CURRENT_KEY_VERSION = 1; // 主密钥版本;轮转时 +1(轮转脚本按版本分批重加密)

/** 从环境变量取主密钥并归一到 32 字节(AES-256)。缺失返回 null(调用方回落 .env)。
 *  接受 base64 或原文;统一 sha256 到 32 字节(允许任意长度 MASTER_KEY,稳定派生密钥)。 */
export function masterKey(): Buffer | null {
  const raw = process.env.MASTER_KEY;
  if (!raw) return null;
  // sha256 归一:无论 MASTER_KEY 多长都得到稳定 32 字节;openssl rand -base64 32 直接可用。
  return createHash('sha256').update(raw, 'utf8').digest();
}

export interface CipherBundle {
  cipher: Buffer;
  iv: Buffer;
  tag: Buffer;
  keyVersion: number;
}

/** 加密明文 key。aad = provider.id(绑定到行,防行间搬移)。无 MASTER_KEY 抛错(调用方先判断)。 */
export function encryptKey(plain: string, aad: string): CipherBundle {
  const mk = masterKey();
  if (!mk) throw new Error('MASTER_KEY 未配置,无法加密');
  const iv = randomBytes(12); // GCM 推荐 96-bit IV
  const c = createCipheriv('aes-256-gcm', mk, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const cipher = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return { cipher, iv, tag, keyVersion: CURRENT_KEY_VERSION };
}

/** 解密。aad 必须与加密时一致(provider.id)。tag/aad/key 不符 → 抛错(GCM 认证失败)。 */
export function decryptKey(bundle: CipherBundle, aad: string): string {
  const mk = masterKey();
  if (!mk) throw new Error('MASTER_KEY 未配置,无法解密');
  const d = createDecipheriv('aes-256-gcm', mk, bundle.iv);
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(bundle.tag);
  return Buffer.concat([d.update(bundle.cipher), d.final()]).toString('utf8');
}

/** 脱敏尾号:admin 只看这个(sk-***xY2)。短 key 也不暴露中段。 */
export function lastFour(plain: string): string {
  if (!plain) return '';
  const tail = plain.slice(-4);
  return `***${tail}`;
}
