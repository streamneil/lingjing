// 由 showcase-assets.json(gen-showcase.mjs 产出)生成 prototype/showcase-data.js。
// 封面走 OSS 公网直链(生产:图不进 git、不经 Node 伺服)。
// 用法:node scripts/build-showcase-data.mjs  [--oss https://your-bucket.oss-region.aliyuncs.com/]

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// 去中心化后无需 OSS 前缀:前端走相对 /api/showcase-asset/,与环境无关(见 ABS)。

const assets = JSON.parse(readFileSync(join(ROOT, 'prototype/showcase/showcase-assets.json'), 'utf8'));
// tool → {中文名, 工具页, 一键复用动作文案}。多模态:img2video/ai-image-edit 本轮接 ?prompt=(只文本)。
const TOOL = {
  'ai-image': { name: 'AI 图片', page: 'ai-image.html', action: '用这个提示词' },
  text2video: { name: '文字转影片', page: 'text2video.html', action: '用这个提示词' },
  img2video: { name: '图片转影片', page: 'img2video.html', action: '用这个提示词' },
  'ai-image-edit': { name: 'AI 图片编辑器', page: 'ai-image-edit.html', action: '用这个编辑指令' },
  'ai-video-edit': { name: 'AI 影片编辑器', page: 'video-edit.html', action: '用这个编辑指令' },
  'ai-avatar': { name: 'AI 虚拟人', page: 'avatars.html', action: '去做同款数字人' },
};
// 相对 key(showcase/<sub>)→ 本端点 /api/showcase-asset/<sub>(签名重定向到自己桶 / 本地兜底,见 src/api/showcase.ts)。
// 去中心化:前端不再引用任何外部桶,URL 与环境无关,部署即自包含。
const ABS = (u) => {
  if (!u) return u;
  if (/^https?:/.test(u)) return u; // 迁移后不应再有绝对 URL;保留兜底不破坏
  const sub = u.replace(/^showcase\//, '');
  return '/api/showcase-asset/' + sub.split('/').map(encodeURIComponent).join('/');
};

// 归一化各模态为统一卡片模型。modality 缺省按字段推断(兼容历史纯图条目)。
function norm(x) {
  const modality = x.modality || (x.ossKey ? 'image' : (x.videoUrl ? 'video' : (x.afterUrl ? 'image-edit' : 'image')));
  const t = TOOL[x.tool] || TOOL['ai-image'];
  const base = {
    id: x.id, theme: x.theme, title: x.title || x.id, modality,
    tool: x.tool || 'ai-image', toolName: t.name, page: t.page,
    actionLabel: t.action,
    // actionText:一键带去工具的文本(图/影片=prompt,编辑=编辑指令,数字人=口播文案)
    actionText: x.prompt || x.text || '',
    prompt: x.prompt || x.text || '',
  };
  if (modality === 'image') return { ...base, poster: ABS(x.ossKey || x.url), url: ABS(x.ossKey || x.url) };
  if (modality === 'video') return { ...base, poster: ABS(x.posterUrl), videoUrl: ABS(x.videoUrl) };
  // refUrls:参考图(如换装的参考衣服图),一键复用时带进编辑器「参考图」槽。逐个 ABS。
  const refUrls = Array.isArray(x.refUrls) && x.refUrls.length ? { refUrls: x.refUrls.map(ABS) } : {};
  if (modality === 'video-edit') return { ...base, poster: ABS(x.posterUrl || x.sourceUrl), videoUrl: ABS(x.videoUrl), ...refUrls };
  if (modality === 'image-edit') return { ...base, poster: ABS(x.afterUrl), beforeUrl: ABS(x.beforeUrl), afterUrl: ABS(x.afterUrl), ...refUrls };
  if (modality === 'avatar') return { ...base, poster: ABS(x.sourceUrl), videoUrl: ABS(x.videoUrl), sourceUrl: ABS(x.sourceUrl) };
  return base;
}
// 只收成功生成项(有可展示的 poster)。
const items = assets.map(norm).filter((x) => x.poster);
const byMod = items.reduce((a, x) => { a[x.modality] = (a[x.modality] || 0) + 1; return a; }, {});

const js = '// 灵镜 探索页 多模态真实样例库 —— 由 scripts/build-showcase-data.mjs 生成,勿手改。\n'
  + '// 封面/视频 = 平台自产,走相对 /api/showcase-asset/(签名重定向自己桶 / 本地兜底,去中心化自包含)。\n'
  + '// 重生成:node scripts/gen-showcase.mjs --go && node scripts/gen-multimodal.mjs --go && node scripts/build-showcase-data.mjs\n'
  + `window.LJShowcase = ${JSON.stringify(items, null, 2)};\n`;
writeFileSync(join(ROOT, 'prototype/showcase-data.js'), js);
console.log(`✓ showcase-data.js: ${items.length} 项  按模态: ${JSON.stringify(byMod)}  (URL 走 /api/showcase-asset)`);
