// 一次性迁移:把 showcase-assets.json 里的绝对 lh-lingjing URL 下载到 prototype/showcase/,
// 并把字段值改写成相对 key(showcase/<subpath>)。跑完即可删本脚本。
// 规则:URL 路径 /showcase/X → key showcase/X;/images|/image-inputs/... → showcase/explore/<basename>;
//       /videos/... → showcase/videos/<basename>。已是相对 key(showcase/...)的原样保留。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const ROOT = join(dirname(new URL(import.meta.url).pathname), '..');
const JSON_PATH = join(ROOT, 'prototype/showcase/showcase-assets.json');
const SHOWCASE = join(ROOT, 'prototype/showcase');
const HOST = 'https://lh-lingjing.oss-cn-hangzhou.aliyuncs.com/';

const data = JSON.parse(readFileSync(JSON_PATH, 'utf8'));
const seen = new Map(); // url/key -> relKey (dedup downloads)
let dl = 0, skip = 0, fail = 0;

function relKeyFor(val) {
  // 相对 key(已 showcase/...):原样
  if (!/^https?:/.test(val)) return val.startsWith('showcase/') ? val : `showcase/${val.replace(/^\/+/, '')}`;
  // 绝对 lh-lingjing URL → 路径
  const path = val.replace(HOST, '').replace(/^https?:\/\/[^/]+\//, '').split('?')[0];
  if (path.startsWith('showcase/')) return path;
  const base = path.split('/').pop();
  if (path.startsWith('videos/')) return `showcase/videos/${base}`;
  return `showcase/explore/${base}`; // images/ image-inputs/ 等
}

async function fetchTo(url, diskPath) {
  if (existsSync(diskPath)) { skip++; return true; }
  mkdirSync(dirname(diskPath), { recursive: true });
  const r = await fetch(url).catch(() => null);
  if (!r || !r.ok) { fail++; console.warn(`  FAIL ${r ? r.status : 'ERR'} ${url}`); return false; }
  const buf = Buffer.from(await r.arrayBuffer());
  writeFileSync(diskPath, buf);
  dl++;
  return true;
}

// 只改写绝对 lh-lingjing URL(字符串或字符串数组);其余字段不动。通用遍历所有 key。
async function migrateVal(item) {
  if (typeof item !== 'string' || !/^https?:.*lh-lingjing/.test(item)) return item;
  const relKey = relKeyFor(item);
  const sub = relKey.replace(/^showcase\//, '');
  const disk = join(SHOWCASE, sub);
  if (!seen.has(item)) { await fetchTo(item, disk); seen.set(item, relKey); }
  return relKey;
}
const arr = Array.isArray(data) ? data : [];
for (const entry of arr) {
  for (const f of Object.keys(entry)) {
    const v = entry[f];
    if (Array.isArray(v)) {
      entry[f] = await Promise.all(v.map(migrateVal));
    } else {
      entry[f] = await migrateVal(v);
    }
  }
}

writeFileSync(JSON_PATH, JSON.stringify(arr, null, 2) + '\n');
console.log(`\n迁移完成: 下载 ${dl}, 跳过(已存在) ${skip}, 失败 ${fail}。showcase-assets.json 已改写为相对 key。`);
process.exit(fail > 0 ? 1 : 0);
