// 灵镜 探索/落地页 真封面批量生成 —— 用配置的 DASHSCOPE key + OSS,跑真实提示词出图。
//
// 设计来源:用户「用配好的 APIKEY/OSS 把探索和落地页模板填满,费用 100 元以内」。
//   - 直连 DashScope text2image(绕过积分/job 队列 —— 积分是对终端用户的内部计费,
//     与真实 RMB 花费无关;这里要量的是真金白银)。
//   - 默认 --dry(只验 1 张),确认链路通 + 实测单价后,再 --go 全量。
//   - 成品下载落 prototype/showcase/ 本地 + 上传 OSS,产出 showcase-assets.json 供页面引用。
//
// 用法:
//   node scripts/gen-showcase.mjs --probe          # 只跑 1 张最便宜的,验链路 + 计时(默认)
//   node scripts/gen-showcase.mjs --go --limit 10  # 真跑前 10 条(带预算闸)
//   node scripts/gen-showcase.mjs --go             # 全量(受 --budget 元闸限制)
//   node scripts/gen-showcase.mjs --go --budget 80 # 真实 RMB 预算上限(元),触顶即停
//
// 预算闸:每张按 --price(默认 0.2 元/张保守估)累加,超 --budget 立即停,绝不超支。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');

// 极简 .env 加载(同 src/config.ts,不引 dotenv 依赖)。已存在的真实 env 优先。
try {
  const raw = readFileSync(resolve(ROOT, '.env'), 'utf8');
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* 无 .env 走真实环境变量 */ }

// ---- args ----
const A = process.argv.slice(2);
const has = (f) => A.includes(f);
const val = (f, d) => { const i = A.indexOf(f); return i >= 0 && A[i + 1] ? A[i + 1] : d; };
const GO = has('--go');
const LIMIT = Number(val('--limit', GO ? '9999' : '1'));
const BUDGET = Number(val('--budget', '90'));     // 元,留 10 元安全垫(用户上限 100)
const PRICE = Number(val('--price', '0.2'));       // 元/张 保守估,probe 后用实测覆盖
const MODEL = val('--model', 'wan2.2-t2i-flash');  // 最便宜档之一
const SIZE = val('--size', '1024*1024');

const KEY = process.env.DASHSCOPE_API_KEY;
const BASE = process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/api/v1';
if (!KEY) { console.error('✗ 缺 DASHSCOPE_API_KEY(检查 .env)'); process.exit(1); }

const OUT_DIR = join(ROOT, 'prototype', 'showcase');
mkdirSync(OUT_DIR, { recursive: true });

// ---- DashScope text2image:提交 → 轮询 → 取 results[].url ----
async function submit(prompt) {
  const r = await fetch(`${BASE}/services/aigc/text2image/image-synthesis/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'X-DashScope-Async': 'enable' },
    body: JSON.stringify({ model: MODEL, input: { prompt }, parameters: { n: 1, size: SIZE } }),
  });
  const j = await r.json();
  if (r.status !== 200) throw new Error(`提交失败 HTTP ${r.status}: ${JSON.stringify(j?.message ?? j)}`);
  const id = j?.output?.task_id;
  if (!id) throw new Error(`未返回 task_id: ${JSON.stringify(j?.output ?? j)}`);
  return id;
}
async function poll(taskId, timeoutMs = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await fetch(`${BASE}/tasks/${taskId}`, { headers: { Authorization: `Bearer ${KEY}` } });
    const j = await r.json();
    const st = j?.output?.task_status;
    if (st === 'SUCCEEDED') {
      const url = j?.output?.results?.[0]?.url;
      if (!url) throw new Error(`成功但无 url: ${JSON.stringify(j?.output)}`);
      return { url, usage: j?.usage ?? j?.output?.usage ?? null };
    }
    if (st === 'FAILED') throw new Error(`任务失败: ${j?.output?.message ?? j?.output?.code ?? '未知'}`);
    await new Promise((s) => setTimeout(s, 2500));
  }
  throw new Error('轮询超时');
}

// ---- OSS 上传(配了就传;失败不致命,本地仍留) ----
let putObjectFromUrl = null;
async function loadStorage() {
  try {
    const mod = await import('../src/storage/index.ts').catch(() => import('../src/storage/index.js'));
    putObjectFromUrl = mod.putObjectFromUrl;
    return mod.storageBackendName;
  } catch (e) { return `(storage 模块加载失败: ${e.message})`; }
}

async function genOne(item, idx) {
  const t0 = Date.now();
  const taskId = await submit(item.prompt);
  const { url, usage } = await poll(taskId);
  const sec = ((Date.now() - t0) / 1000).toFixed(1);

  // 下载到本地
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  const fname = `${item.id}.jpg`;
  writeFileSync(join(OUT_DIR, fname), buf);

  // 上传 OSS
  let ossKey = null;
  if (putObjectFromUrl) {
    try { ossKey = await putObjectFromUrl(`showcase/${fname}`, url); }
    catch (e) { console.warn(`  ⚠ OSS 上传失败(本地已存): ${e.message}`); }
  }
  console.log(`  ✓ [${idx}] ${item.id} ${sec}s ${(buf.length / 1024).toFixed(0)}KB${ossKey ? ' → OSS ' + ossKey : ''}${usage ? ' usage=' + JSON.stringify(usage) : ''}`);
  return { id: item.id, theme: item.theme, modality: item.modality, tool: item.tool, prompt: item.prompt, file: `showcase/${fname}`, ossKey, bytes: buf.length, sec: +sec };
}

async function main() {
  const backend = await loadStorage();
  console.log(`\n灵镜 真封面生成  model=${MODEL} size=${SIZE} storage=${backend}`);
  console.log(`模式=${GO ? 'GO(真跑)' : 'PROBE(只验1张)'}  limit=${LIMIT}  预算=${BUDGET}元  估价=${PRICE}元/张\n`);

  // 提示词清单:probe 用 1 条;GO 读 scripts/showcase-prompts.json
  let items;
  if (!GO) {
    items = [{ id: 'probe-hanfu', theme: '古风人像', modality: 'image', tool: 'ai-image',
      prompt: '身姿曼妙的古装美女,身着轻薄飘逸的古风唐装仙女长裙,头戴镶嵌珍珠宝石的精美发饰,在湛蓝高空优雅飞翔,下方金灿灿油菜花田与碧绿湖泊,蓝天白云,如梦似幻仙气,低角度全身,高清画质' }];
  } else {
    const pf = join(__dir, 'showcase-prompts.json');
    if (!existsSync(pf)) { console.error(`✗ 缺 ${pf} —— 先生成提示词清单再 --go`); process.exit(1); }
    items = JSON.parse(readFileSync(pf, 'utf8')).slice(0, LIMIT);
  }

  const done = [];
  let spent = 0;
  for (let i = 0; i < items.length; i++) {
    if (spent + PRICE > BUDGET) { console.log(`\n⛔ 预算闸:已估 ${spent.toFixed(2)}元,再跑会超 ${BUDGET}元,停。`); break; }
    try { done.push(await genOne(items[i], i + 1)); spent += PRICE; }
    catch (e) { console.error(`  ✗ [${i + 1}] ${items[i].id} 失败: ${e.message}`); }
  }

  if (done.length) {
    const manifest = join(OUT_DIR, 'showcase-assets.json');
    const prev = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : [];
    const byId = new Map(prev.map((x) => [x.id, x]));
    for (const d of done) byId.set(d.id, d);
    writeFileSync(manifest, JSON.stringify([...byId.values()], null, 2));
    console.log(`\n✓ 完成 ${done.length} 张,估花 ${spent.toFixed(2)}元。清单: ${manifest}`);
  } else {
    console.log('\n(无成品)');
  }
  if (!GO) console.log('\n→ PROBE 通过后:用实测单价跑  node scripts/gen-showcase.mjs --go --price <实测> --budget 90');
}

main().catch((e) => { console.error('致命错误:', e.message); process.exit(1); });
