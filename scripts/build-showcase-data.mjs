// 由 showcase-assets.json(gen-showcase.mjs 产出)生成 prototype/showcase-data.js。
// 封面走 OSS 公网直链(生产:图不进 git、不经 Node 伺服)。
// 用法:node scripts/build-showcase-data.mjs  [--oss https://your-bucket.oss-region.aliyuncs.com/]

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const A = process.argv.slice(2);
const ossArg = (() => { const i = A.indexOf('--oss'); return i >= 0 ? A[i + 1] : null; })();
// 默认从 .env 推 OSS 公网前缀(region+bucket);也可 --oss 覆盖。
function ossBaseFromEnv() {
  try {
    const env = Object.fromEntries(readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
      .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)).filter(Boolean)
      .map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]));
    const region = (env.OSS_REGION || '').replace(/^https?:\/\//, '').replace(/\.aliyuncs\.com.*$/, '');
    if (env.OSS_BUCKET && region) return `https://${env.OSS_BUCKET}.${region}.aliyuncs.com/`;
  } catch { /* ignore */ }
  return null;
}
const OSS = ossArg || ossBaseFromEnv();
if (!OSS) { console.error('✗ 无法确定 OSS 公网前缀,请用 --oss 指定'); process.exit(1); }

const assets = JSON.parse(readFileSync(join(ROOT, 'prototype/showcase/showcase-assets.json'), 'utf8'));
const TOOL = {
  'ai-image': { name: 'AI 图片', page: 'ai-image.html' },
  text2video: { name: '文字转影片', page: 'text2video.html' },
  'ai-avatar': { name: 'AI 虚拟人', page: 'avatars.html' },
};
const items = assets.filter((x) => x.ossKey).map((x) => ({
  id: x.id, theme: x.theme, title: x.title || x.id, tool: x.tool,
  toolName: (TOOL[x.tool] || {}).name || 'AI 图片', page: (TOOL[x.tool] || {}).page || 'ai-image.html',
  prompt: x.prompt, url: OSS + x.ossKey,
}));
const js = '// 灵镜 探索/落地页 真实样例库 —— 由 scripts/build-showcase-data.mjs 生成,勿手改。\n'
  + '// 封面 = 平台自产真图,存 OSS 公网直链(生产路线:图不进 git,不经 Node 伺服)。\n'
  + '// 重生成:node scripts/gen-showcase.mjs --go && node scripts/build-showcase-data.mjs\n'
  + `window.LJShowcase = ${JSON.stringify(items, null, 2)};\n`;
writeFileSync(join(ROOT, 'prototype/showcase-data.js'), js);
console.log(`✓ showcase-data.js: ${items.length} 项,封面前缀 ${OSS}`);
