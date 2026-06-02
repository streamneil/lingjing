#!/usr/bin/env node
// 灵镜 C-code 探针 — 用真实 wan2.2-s2v 接口打穿数字人视频链路。
//
// 查证(2026-06 阿里官方)真实接口:
//   POST /services/aigc/image2video/video-synthesis/  (X-DashScope-Async: enable)
//   input:{ image_url, audio_url }  parameters:{ resolution:'480P'|'720P' }
//   → output.task_id → GET /tasks/:id 轮询 → output.video_url
//   ⚠️ image_url / audio_url 必须公网可访问。
//
// 本探针用阿里官方示例素材(公网可访问)直接打穿,验证 key+额度+效果,
// 不依赖你自己的图/音频。用法:node scripts/probe-baichuan.mjs

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function loadEnv() {
  try {
    const raw = readFileSync(resolve(process.cwd(), '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { console.error('⚠️  没找到 .env'); process.exit(1); }
}
loadEnv();

const API_KEY = process.env.DASHSCOPE_API_KEY;
if (!API_KEY) { console.error('⚠️  缺少 DASHSCOPE_API_KEY'); process.exit(1); }
const BASE = process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/api/v1';
const MODEL = process.env.BAICHUAN_AVATAR_MODEL || 'wan2.2-s2v';

// 阿里官方文档示例素材(公网可访问)。换成你自己的图/音频也行。
const IMAGE_URL = process.env.PROBE_IMAGE_URL
  || 'https://dashscope.oss-cn-beijing.aliyuncs.com/images/wan_s2v/pose.png';
const AUDIO_URL = process.env.PROBE_AUDIO_URL
  || 'https://dashscope.oss-cn-beijing.aliyuncs.com/samples/audio/cosyvoice/cosyvoice-zeroshot-sample.wav';

const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

async function http(method, path, body, extra = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json', ...extra },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { _raw: text.slice(0, 800) }; }
  return { status: res.status, json };
}

(async () => {
  console.log('=== 灵镜 C-code 探针:wan2.2-s2v 数字人链路 ===\n');
  console.log(`[${el()}] 提交 ${MODEL}(image_url + audio_url)...`);
  const sub = await http(
    'POST',
    '/services/aigc/image2video/video-synthesis/',
    { model: MODEL, input: { image_url: IMAGE_URL, audio_url: AUDIO_URL }, parameters: { resolution: '720P' } },
    { 'X-DashScope-Async': 'enable' },
  );
  console.log(`[${el()}] HTTP ${sub.status}`);
  if (sub.status !== 200) { console.error('❌ 提交失败:'); console.dir(sub.json, { depth: 4 }); process.exit(2); }
  const taskId = sub.json?.output?.task_id;
  if (!taskId) { console.error('❌ 无 task_id:'); console.dir(sub.json, { depth: 4 }); process.exit(2); }
  console.log(`[${el()}] task_id=${taskId},开始轮询...`);

  const timeout = Date.now() + 10 * 60 * 1000;
  for (;;) {
    if (Date.now() > timeout) { console.error('❌ 轮询超时'); process.exit(4); }
    await new Promise((r) => setTimeout(r, 3000));
    const q = await http('GET', `/tasks/${taskId}`);
    const st = q.json?.output?.task_status;
    console.log(`[${el()}] task_status=${st}`);
    if (st === 'SUCCEEDED') {
      const url = q.json?.output?.video_url;
      console.log('\n=== 探针报告 ===');
      console.log(`✅ 端到端耗时: ${el()}`);
      console.log(`📹 视频 URL: ${url}`);
      console.log('❓ 下载看:口型同步?形象自然?是否自带 AI 标识?(决定是否需 ffmpeg 后处理)');
      process.exit(0);
    }
    if (st === 'FAILED' || st === 'UNKNOWN') { console.error('❌ 失败:', JSON.stringify(q.json?.output)); process.exit(3); }
  }
})().catch((e) => { console.error('❌ 探针异常:', e); process.exit(1); });
