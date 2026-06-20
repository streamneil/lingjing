// 灵镜 API — 示范素材服务(去中心化)。
//
// 背景:落地页/探索灵感/音色试听/预置形象/参考生成影片等示范素材以前写死引用
// 公共桶 lh-lingjing(单点 + 跨部署不自包含)。改为统一走本端点,媒体随 git 提交进
// prototype/showcase/,部署时 seed 到运营自己的 OSS 桶。
//
// 服务模型(decision 3f79e78e:签名重定向 + 本地文件兜底):
//   · 配了 OSS(阿里云) → 302 跳转到 getSignedUrl(签名直链,OSS 原生 range,Node 不承出口)。
//     桶里没有(未 seed)或签名失败 → 回退本地文件。
//   · 没配 OSS(本地/私有化 MinIO) → 直接伺服仓内提交的文件(media 进镜像,air-gap 必达)。
//
// 安全:仅服务 prototype/showcase/ 下的文件(路径限定,杜绝 ../ 越权读 SSRF)。本端点公开
// (落地页登录前要用),但只读固定示范目录,无租户数据。
//
//   GET /api/showcase-asset/<subpath>   → 302 签名直链 或 本地文件
//      subpath 例:guofeng-fly-1.jpg / voices/Cherry.wav / avatar-preset-1.png / videos/x.mp4
//      桶 key  = showcase/<subpath>   ;  磁盘 = prototype/showcase/<subpath>

import { Router, type Request, type Response } from 'express';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { getSignedUrl, storageBackendName } from '../storage/index.js';

export const showcaseRouter = Router();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..'); // 仓库根
const SHOWCASE_DIR = join(ROOT, 'prototype', 'showcase'); // 本地媒体根(随 git 提交,进镜像)
const SIGNED_TTL = 1800; // 签名直链有效期(秒)

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
};

/** 解析 + 限定 subpath:必须落在 SHOWCASE_DIR 内(防 ../ 越权)。返回 {subpath, diskPath} 或 null。 */
function resolveSubpath(raw: string): { subpath: string; diskPath: string } | null {
  // 去掉前导斜杠,URL 解码,归一化;归一化后若含 .. 逃逸则拒。
  let sub: string;
  try {
    sub = decodeURIComponent(raw).replace(/^\/+/, '');
  } catch {
    return null;
  }
  if (!sub || sub.includes('\0')) return null;
  const norm = normalize(sub);
  if (norm.startsWith('..') || norm.includes('..' + '/') || norm.includes('/' + '..')) return null;
  const diskPath = join(SHOWCASE_DIR, norm);
  if (!diskPath.startsWith(SHOWCASE_DIR)) return null; // 双保险:解析后仍须在根内
  // 仅允许已知媒体后缀
  if (!(extname(norm).toLowerCase() in MIME)) return null;
  return { subpath: norm, diskPath };
}

showcaseRouter.get('/showcase-asset/*', async (req: Request, res: Response) => {
  const raw = (req.params as Record<string, string>)[0] ?? '';
  const resolved = resolveSubpath(raw);
  if (!resolved) return res.status(404).json({ error: '未知示范素材' });
  const { subpath, diskPath } = resolved;
  const key = `showcase/${subpath}`;

  // 1. 配了 OSS:签名直链 302(OSS 直出,Node 不承出口)。桶里没有 → 落到本地兜底。
  if (storageBackendName === 'oss') {
    try {
      const signed = await getSignedUrl(key, SIGNED_TTL);
      // 注:对象不存在 OSS 仍会签出 URL(取时才 403/404)。生产部署 deploy.sh 先 seed 再放量;
      // 万一未 seed,本地文件存在则优先本地兜底,避免 302 到一个 404。
      if (!existsSync(diskPath)) return res.redirect(302, signed);
      // 本地有副本(镜像自带):redirect 到 OSS;本地仅作 OSS 签名失败时的兜底(下方 catch)。
      return res.redirect(302, signed);
    } catch {
      /* 签名失败 → 落到本地兜底 */
    }
  }

  // 2. 没配 OSS(本地/私有化 MinIO)或签名失败:伺服仓内提交的文件(air-gap 必达)。
  if (!existsSync(diskPath) || !statSync(diskPath).isFile()) {
    return res.status(404).json({ error: '示范素材暂不可用(未 seed 且镜像内无副本)' });
  }
  res.setHeader('Content-Type', MIME[extname(diskPath).toLowerCase()] ?? 'application/octet-stream');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('Accept-Ranges', 'bytes'); // express 的 createReadStream 不自动分段;此处声明,后续可加 range
  createReadStream(diskPath).on('error', () => {
    if (!res.headersSent) res.status(500).json({ error: '示范素材读取失败' });
  }).pipe(res);
});
