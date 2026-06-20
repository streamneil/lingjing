#!/usr/bin/env node
// 灵镜 — 示范素材一键灌桶。把仓内提交的 prototype/showcase/** 上传到运营自己的存储桶,
// 桶 key = showcase/<相对路径>(与 /api/showcase-asset 端点一致)。部署后 deploy.sh 自动跑。
//
//   DB_FILE=/data/lingjing.db npx tsx scripts/seed-showcase.mjs        # 幂等:已存在则跳过
//   npx tsx scripts/seed-showcase.mjs --force                          # 强制覆盖
//
// 设计:从本地文件树读(不联网),air-gap 也能灌;配了 OSS → 传 OSS,否则 MinIO。
// 与端点配套:即便没 seed,/api/showcase-asset 也会回退伺服镜像内文件;seed 只是把出口卸到桶/CDN。

import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { putObject, getObject, ensureBucket, storageBackendName } from '../src/storage/index.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOWCASE = join(ROOT, 'prototype', 'showcase');
const FORCE = process.argv.includes('--force');

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
};

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (extname(name).toLowerCase() in MIME) out.push(p);
  }
  return out;
}

async function exists(key) {
  try { const b = await getObject(key); return b && b.length > 0; } catch { return false; }
}

async function main() {
  if (!existsSync(SHOWCASE)) {
    console.error(`[seed-showcase] ✗ 找不到 ${SHOWCASE}(媒体未随仓拉取?)`);
    process.exit(1);
  }
  await ensureBucket();
  const files = walk(SHOWCASE);
  console.log(`[seed-showcase] backend=${storageBackendName} 待处理 ${files.length} 个媒体文件${FORCE ? '(--force 覆盖)' : ''}`);
  let made = 0, skipped = 0, failed = 0;
  for (const f of files) {
    const rel = relative(SHOWCASE, f).split('\\').join('/'); // win 兼容
    const key = `showcase/${rel}`;
    try {
      if (!FORCE && (await exists(key))) { skipped++; continue; }
      await putObject(key, readFileSync(f), MIME[extname(f).toLowerCase()] || 'application/octet-stream');
      made++;
    } catch (e) {
      failed++;
      console.warn(`  ✗ ${key}: ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log(`[seed-showcase] 完成:新传 ${made},跳过 ${skipped},失败 ${failed}。`);
  if (failed > 0) {
    console.error(`[seed-showcase] ✗ 有 ${failed} 个失败 —— 落地页/探索/试听/参考生成影片可能裂图。请检查 OSS 配置后重跑(幂等)。`);
    process.exit(1); // 大声失败:让 deploy 能感知
  }
}

main().catch((e) => { console.error('[seed-showcase] 崩:', e); process.exit(1); });
