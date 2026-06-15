// 灵镜 探索页多模态样片生成 —— 用配置的 DASHSCOPE key + OSS,跑真实 i2v / 图片编辑 / 数字人样片。
//
// 设计来源:CEO plan 2026-06-15-explore-multimodal.md(方案 A) + eng-review。
//   三条 DashScope 管线(端点经 src/gateway/baichuan.ts + cosyvoice.ts 核实):
//     img2video : POST /services/aigc/video-generation/video-synthesis (input.media=[{type:'first_frame',url}])
//     图片编辑   : POST /services/aigc/image-generation/generation (input.messages[].content=[{image},{text}])
//     数字人 s2v: ① TTS multimodal-generation → 音频 → ② 上传 OSS → ③ image2video/video-synthesis (image_url+audio_url)
//   全部复用现有 OSS showcase/*.jpg 作输入(平台自产,非 image-inputs/<tenant>/,不涉租户合规)。
//
// 用法:
//   node scripts/gen-multimodal.mjs --probe              # 各管线跑 1 条验通(默认)
//   node scripts/gen-multimodal.mjs --go                 # 全量(受 --budget 元闸)
//   node scripts/gen-multimodal.mjs --go --only video    # 只跑某管线 video|edit|avatar
//   node scripts/gen-multimodal.mjs --go --budget 70     # 真实 RMB 预算上限(元)
//
// ⚠️ 预算:视频/数字人按秒计费,API usage 返时长非 RMB;真实 RMB 以百炼控制台账单为准。
//    --price-* 为保守估,probe 后用控制台实费校准。累计估值超 --budget 立即停。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');

// 极简 .env 加载(同 gen-showcase.mjs,不引 dotenv)。已存在的真实 env 优先。
try {
  const raw = readFileSync(resolve(ROOT, '.env'), 'utf8');
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* 无 .env 走真实环境变量 */ }

const A = process.argv.slice(2);
const has = (f) => A.includes(f);
const val = (f, d) => { const i = A.indexOf(f); return i >= 0 && A[i + 1] ? A[i + 1] : d; };
const GO = has('--go');
const ONLY = val('--only', null); // video | edit | avatar
const IDS = val('--ids', null); // 逗号分隔的 id 子集(只跑这些;补跑失败项用)
const idSet = IDS ? new Set(IDS.split(',')) : null;
const BUDGET = Number(val('--budget', '80'));
const PRICE = { video: Number(val('--price-video', '1.0')), edit: Number(val('--price-edit', '0.3')), avatar: Number(val('--price-avatar', '2.0')) };

const KEY = process.env.DASHSCOPE_API_KEY;
const BASE = process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/api/v1';
if (!KEY) { console.error('✗ 缺 DASHSCOPE_API_KEY(检查 .env)'); process.exit(1); }
const OSS = 'https://lh-lingjing.oss-cn-hangzhou.aliyuncs.com/';
const OUT_DIR = join(ROOT, 'prototype', 'showcase');
mkdirSync(OUT_DIR, { recursive: true });
const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

// ── 通用:异步提交后轮询 /tasks/:id ──
async function pollTask(taskId, { videoKey = false, timeoutMs = 300000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await fetch(`${BASE}/tasks/${taskId}`, { headers: { Authorization: `Bearer ${KEY}` } });
    const j = await r.json();
    const st = j?.output?.task_status;
    if (st === 'SUCCEEDED') return j.output;
    if (st === 'FAILED') throw new Error(`任务失败: ${j?.output?.message ?? j?.output?.code ?? '未知'}`);
    await new Promise((s) => setTimeout(s, 3000));
  }
  throw new Error('轮询超时');
}

// ── OSS 上传(复用 src/storage)──
let putObject = null, putObjectFromUrl = null;
async function loadStorage() {
  try {
    const mod = await import('../src/storage/index.ts').catch(() => import('../src/storage/index.js'));
    putObject = mod.putObject; putObjectFromUrl = mod.putObjectFromUrl;
    return mod.storageBackendName;
  } catch (e) { return `(storage 加载失败: ${e.message})`; }
}

// ── 管线 1:img2video(首帧 i2v)──
async function genVideo(item) {
  const r = await fetch(`${BASE}/services/aigc/video-generation/video-synthesis`, {
    method: 'POST', headers: { ...H, 'X-DashScope-Async': 'enable' },
    body: JSON.stringify({
      model: item.model || 'wan2.7-i2v-2026-04-25',
      input: { prompt: item.prompt, media: [{ type: 'first_frame', url: OSS + item.inputKey }] },
      parameters: { resolution: '720P', duration: 5 },
    }),
  });
  const j = await r.json();
  if (r.status !== 200) throw new Error(`i2v 提交失败 HTTP ${r.status}: ${JSON.stringify(j?.message ?? j)}`);
  const out = await pollTask(j.output.task_id, { videoKey: true });
  const videoUrl = out?.results?.video_url ?? out?.video_url;
  if (!videoUrl) throw new Error(`i2v 成功但无 video_url: ${JSON.stringify(out)}`);
  const key = `showcase/${item.id}.mp4`;
  await putObjectFromUrl(key, videoUrl);
  return { ...item, modality: 'video', videoUrl: OSS + key, posterUrl: OSS + item.inputKey };
}

// ── 管线 2:图片编辑(前后对比)──
async function genEdit(item) {
  const r = await fetch(`${BASE}/services/aigc/image-generation/generation`, {
    method: 'POST', headers: { ...H, 'X-DashScope-Async': 'enable' },
    body: JSON.stringify({
      model: item.model || 'wan2.7-image',
      input: { messages: [{ role: 'user', content: [{ image: OSS + item.inputKey }, { text: item.prompt }] }] },
      parameters: { n: 1, watermark: false },
    }),
  });
  const j = await r.json();
  if (r.status !== 200) throw new Error(`编辑提交失败 HTTP ${r.status}: ${JSON.stringify(j?.message ?? j)}`);
  const out = await pollTask(j.output.task_id);
  // 成功 output.choices[0].message.content[].image
  const afterUrl = out?.choices?.[0]?.message?.content?.find((c) => c.image)?.image
    ?? out?.results?.[0]?.url;
  if (!afterUrl) throw new Error(`编辑成功但无成品 url: ${JSON.stringify(out)}`);
  const key = `showcase/${item.id}.jpg`;
  await putObjectFromUrl(key, afterUrl);
  return { ...item, modality: 'image-edit', beforeUrl: OSS + item.inputKey, afterUrl: OSS + key };
}

// ── 管线 3:数字人(TTS → 上传 → s2v)──
async function genAvatar(item) {
  // ① TTS
  const tr = await fetch(`${BASE}/services/aigc/multimodal-generation/generation`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ model: 'qwen3-tts-flash', input: { text: item.text, voice: item.voice || 'Cherry' } }),
  });
  const tj = await tr.json();
  if (tr.status !== 200) throw new Error(`TTS 失败 HTTP ${tr.status}: ${JSON.stringify(tj?.message ?? tj)}`);
  const aud = tj.output?.audio;
  let audioBuf;
  if (aud?.url) audioBuf = Buffer.from(await (await fetch(aud.url)).arrayBuffer());
  else if (aud?.data) audioBuf = Buffer.from(aud.data, 'base64');
  else throw new Error('TTS 无音频');
  // ② 上传 OSS 拿公网 url(Qwen-TTS 返 WAV;s2v 校验扩展名,必须 .wav)
  const audioKey = `showcase/${item.id}-audio.wav`;
  await putObject(audioKey, audioBuf, 'audio/wav');
  const audioUrl = OSS + audioKey;
  // ③ s2v
  const sr = await fetch(`${BASE}/services/aigc/image2video/video-synthesis/`, {
    method: 'POST', headers: { ...H, 'X-DashScope-Async': 'enable' },
    body: JSON.stringify({ model: 'wan2.2-s2v', input: { image_url: OSS + item.inputKey, audio_url: audioUrl }, parameters: { resolution: '720P' } }),
  });
  const sj = await sr.json();
  if (sr.status !== 200) throw new Error(`s2v 提交失败 HTTP ${sr.status}: ${JSON.stringify(sj?.message ?? sj)}`);
  const out = await pollTask(sj.output.task_id, { videoKey: true });
  const videoUrl = out?.results?.video_url ?? out?.video_url;
  if (!videoUrl) throw new Error(`s2v 成功但无 video_url: ${JSON.stringify(out)}`);
  const key = `showcase/${item.id}.mp4`;
  await putObjectFromUrl(key, videoUrl);
  return { ...item, modality: 'avatar', videoUrl: OSS + key, sourceUrl: OSS + item.inputKey };
}

// ── 样片清单(复用现有 OSS 图作输入)──
const VIDEO = [
  { id: 'v-guofeng', theme: '古风人像', title: '古风飞天 · 动起来', tool: 'img2video', inputKey: 'showcase/guofeng-fly-1.jpg', prompt: '镜头缓缓推进,裙摆与发丝随风轻舞,云雾流动,仙气飘渺,电影质感' },
  { id: 'v-jiangnan', theme: '江南水乡', title: '烟雨江南 · 流动', tool: 'img2video', inputKey: 'showcase/jiangnan-misty.jpg', prompt: '细雨轻落,水面泛起涟漪,小船缓缓行驶,炊烟袅袅,宁静诗意' },
  { id: 'v-dream', theme: '梦幻风景', title: '粉色心云 · 流转', tool: 'img2video', inputKey: 'showcase/dream-pinkroad.jpg', prompt: '云层缓缓飘动,光影变幻,梦幻唯美,镜头沿雪原长路缓推' },
  { id: 'v-phoenix', theme: '神话生物', title: '山海凤凰 · 振翅', tool: 'img2video', model: 'happyhorse-1.0-i2v', inputKey: 'showcase/myth-phoenix.jpg', prompt: '凤凰羽翼轻展,烈焰流动,粒子飞舞,神话史诗感' },
  { id: 'v-wedding', theme: '婚纱礼服', title: '红凤婚袍 · 灵动', tool: 'img2video', model: 'happyhorse-1.0-i2v', inputKey: 'showcase/wedding-redphoenix.jpg', prompt: '裙摆水晶微微闪烁,金色羽翼轻动,光斑流转,华丽梦幻' },
  { id: 'v-bamboo', theme: '江南水乡', title: '竹林光影 · 微风', tool: 'img2video', model: 'happyhorse-1.0-i2v', inputKey: 'showcase/jiangnan-bamboo.jpg', prompt: '竹叶随风沙沙摇曳,光斑在林间游移,阳光穿透竹影,清幽' },
];
const EDIT = [
  { id: 'e-grandma-bg', theme: '温情肖像', title: '换背景 · 园林', tool: 'ai-image-edit', inputKey: 'showcase/portrait-grandma.jpg', prompt: '把背景换成郁郁葱葱的中式园林,保持人物不变,自然融合' },
  { id: 'e-jiangnan-snow', theme: '江南水乡', title: '变季节 · 江南雪', tool: 'ai-image-edit', inputKey: 'showcase/jiangnan-wuzhen.jpg', prompt: '给这幅江南水乡加上飘雪,屋顶积雪,营造冬日雪景氛围' },
  { id: 'e-guofeng-style', theme: '古风人像', title: '风格化 · 水墨', tool: 'ai-image-edit', inputKey: 'showcase/guofeng-pearl.jpg', prompt: '转成中国传统水墨画风格,保留人物姿态与构图' },
  { id: 'e-dream-expand', theme: '梦幻风景', title: '扩图 · 全景', tool: 'ai-image-edit', inputKey: 'showcase/dream-aurora.jpg', prompt: '向左右扩展画面成宽幅全景,延续极光与星空,自然衔接' },
  { id: 'e-cat-crown', theme: '萌宠动物', title: '加元素 · 皇冠', tool: 'ai-image-edit', inputKey: 'showcase/animal-cat-crown.jpg', prompt: '给猫咪戴上更华丽的宝石皇冠,背景加金色光晕' },
  { id: 'e-warrior-night', theme: '赛博战士', title: '改光照 · 夜景', tool: 'ai-image-edit', inputKey: 'showcase/warrior-cyber.jpg', prompt: '把场景改成霓虹夜景,加入赛博朋克紫红光照,增强氛围' },
];
const AVATAR = [
  { id: 'a-sage', theme: '温情肖像', title: '智者口播', tool: 'ai-avatar', inputKey: 'showcase/portrait-sage.jpg', voice: 'Eldric Sage', text: '大家好,欢迎来到灵镜。在这里,一张照片,就能成为会说话的数字人。' },
  { id: 'a-grandma', theme: '温情肖像', title: '长者寄语', tool: 'ai-avatar', inputKey: 'showcase/portrait-grandma.jpg', voice: 'Serena', text: '岁月温柔,愿你被这世界温柔以待。灵镜,让每一份美好都被看见。' },
  { id: 'a-girl', theme: '可爱萌娃', title: '元气播报', tool: 'ai-avatar', inputKey: 'showcase/girl-rainbow.jpg', voice: 'Chelsie', text: '嗨!我是你的 AI 数字人,影片、配音、配乐,一个平台全搞定!' },
];

const PIPE = { video: { items: VIDEO, fn: genVideo }, edit: { items: EDIT, fn: genEdit }, avatar: { items: AVATAR, fn: genAvatar } };

async function main() {
  const backend = await loadStorage();
  console.log(`\n灵镜 多模态样片生成  storage=${backend}  模式=${GO ? 'GO(真跑)' : 'PROBE(各管线1条)'}  预算=${BUDGET}元`);
  const kinds = ONLY ? [ONLY] : ['video', 'edit', 'avatar'];
  const done = [];
  let spent = 0;
  for (const kind of kinds) {
    const { items, fn } = PIPE[kind];
    let list = GO ? items : items.slice(0, 1);
    if (idSet) list = list.filter((it) => idSet.has(it.id)); // --ids 补跑子集
    console.log(`\n━━ ${kind}(${list.length} 条)━━`);
    for (let i = 0; i < list.length; i++) {
      if (spent + PRICE[kind] > BUDGET) { console.log(`⛔ 预算闸:已估 ${spent.toFixed(2)}元,停。`); break; }
      const it = list[i];
      const t0 = Date.now();
      try {
        const res = await fn(it);
        spent += PRICE[kind];
        done.push(res);
        console.log(`  ✓ ${it.id} ${((Date.now() - t0) / 1000).toFixed(0)}s  (估累计 ${spent.toFixed(2)}元)`);
      } catch (e) {
        console.error(`  ✗ ${it.id} 失败: ${e.message}`);
      }
    }
  }
  if (done.length) {
    const manifest = join(OUT_DIR, 'showcase-assets.json');
    const prev = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : [];
    const byId = new Map(prev.map((x) => [x.id, x]));
    for (const d of done) byId.set(d.id, d);
    writeFileSync(manifest, JSON.stringify([...byId.values()], null, 2));
    console.log(`\n✓ 完成 ${done.length} 条,估花 ${spent.toFixed(2)}元。已并入 ${manifest}`);
  } else console.log('\n(无成品)');
  if (!GO) console.log('\n→ PROBE 通过后:查百炼控制台实费校准 --price-*,再 node scripts/gen-multimodal.mjs --go --budget 80');
}
main().catch((e) => { console.error('致命错误:', e.message); process.exit(1); });
