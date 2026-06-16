#!/usr/bin/env node
// 灵镜 — MASTER_KEY 轮转脚本(model-access-platform PR-1)。
//
// 换主密钥会让库内所有 provider.api_key_cipher 解不出(GCM 认证失败)→ 全 provider 失效。
// 本脚本用【旧】主密钥批量解密 → 【新】主密钥重加密。按 key_version 分批、可断点续(中途崩了重跑安全)。
//
// 用法:
//   OLD_MASTER_KEY='<旧>' NEW_MASTER_KEY='<新>' node scripts/rotate-master-key.mjs
//   生成新主密钥:openssl rand -base64 32
//
// 安全:旧/新主密钥只走环境变量,绝不落盘/打印。

import Database from 'better-sqlite3';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const OLD = process.env.OLD_MASTER_KEY;
const NEW = process.env.NEW_MASTER_KEY;
const DB_FILE = process.env.DB_FILE || 'lingjing.db';
if (!OLD || !NEW) {
  console.error('用法: OLD_MASTER_KEY=... NEW_MASTER_KEY=... node scripts/rotate-master-key.mjs');
  process.exit(1);
}

// 与 src/gateway/key-crypto.ts 同口径:sha256 归一到 32 字节 + AES-256-GCM + AAD=provider.id。
const mk = (raw) => createHash('sha256').update(raw, 'utf8').digest();
const NEW_VERSION = (Number(process.env.NEW_KEY_VERSION) || 2); // 新版本号(默认 2;轮转可递增)

function decrypt(keyBuf, cipher, iv, tag, aad) {
  const d = createDecipheriv('aes-256-gcm', keyBuf, iv);
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(cipher), d.final()]).toString('utf8');
}
function encrypt(keyBuf, plain, aad) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyBuf, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const cipher = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return { cipher, iv, tag: c.getAuthTag() };
}

const db = new Database(DB_FILE);
const oldMk = mk(OLD), newMk = mk(NEW);
// 断点续:只处理 key_version < NEW_VERSION 的行(已轮到新版本的跳过)。
const rows = db.prepare(
  `SELECT id, api_key_cipher, api_key_iv, api_key_tag FROM provider
   WHERE api_key_cipher IS NOT NULL AND key_version < ?`,
).all(NEW_VERSION);

let ok = 0, fail = 0;
const upd = db.prepare('UPDATE provider SET api_key_cipher=?, api_key_iv=?, api_key_tag=?, key_version=?, updated_at=? WHERE id=?');
for (const r of rows) {
  try {
    const plain = decrypt(oldMk, r.api_key_cipher, r.api_key_iv, r.api_key_tag, r.id); // AAD = id
    const e = encrypt(newMk, plain, r.id);
    upd.run(e.cipher, e.iv, e.tag, NEW_VERSION, Date.now(), r.id);
    ok++;
    console.log(`✓ ${r.id} 已重加密 → key_version ${NEW_VERSION}`);
  } catch (err) {
    fail++;
    console.error(`✗ ${r.id} 用旧主密钥解密失败(OLD_MASTER_KEY 是否正确?):${err.message}`);
  }
}
db.close();
console.log(`\n完成:${ok} 个重加密,${fail} 个失败。${fail ? '失败行未改动,修正 OLD_MASTER_KEY 后重跑(幂等)。' : '把部署的 MASTER_KEY 改为新值即可。'}`);
process.exit(fail ? 1 : 0);
