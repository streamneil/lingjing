#!/usr/bin/env node
// 灵镜 连通性探针 — 不依赖数字人 model 名,先验证 key 有效 + 百炼连得通
// 用确定存在的能力(TTS cosyvoice)打一发,确认凭证和网络。
// 跑: node scripts/probe-connectivity.mjs

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

const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

async function http(method, path, body, extra = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json', ...extra },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { _raw: text.slice(0, 500) }; }
  return { status: res.status, json };
}

(async () => {
  console.log('=== 灵镜 连通性探针(验证 key + 百炼可达)===\n');

  // 用文本生成(qwen-turbo 几乎所有百炼账号都开通)做最小连通验证 —— 确定存在、最便宜。
  console.log(`[${el()}] 调 qwen-turbo 验证 key 与连通 ...`);
  const r = await http('POST', '/services/aigc/text-generation/generation', {
    model: 'qwen-turbo',
    input: { messages: [{ role: 'user', content: '只回一个字:好' }] },
    parameters: { max_tokens: 10 },
  });

  console.log(`[${el()}] HTTP ${r.status}`);
  if (r.status === 200) {
    const out = r.json?.output?.text || r.json?.output?.choices?.[0]?.message?.content;
    console.log(`✅ key 有效、百炼可达。模型回复: ${JSON.stringify(out)}`);
    console.log(`✅ request_id: ${r.json?.request_id}`);
    console.log('\n下一步:数字人视频的真实 model 名/形象ID 需从你百炼控制台的"数字人/视频生成"文档拿到,');
    console.log('填进 .env 的 BAICHUAN_AVATAR_MODEL / BAICHUAN_PRESET_AVATAR 后,再跑 probe-baichuan.mjs。');
  } else if (r.status === 401 || r.status === 403) {
    console.error('❌ 认证失败(401/403)。key 可能错了、或没开通对应服务。返回:');
    console.dir(r.json, { depth: 3 });
  } else {
    console.error(`❌ 非预期响应 ${r.status}:`);
    console.dir(r.json, { depth: 3 });
  }
})().catch((e) => { console.error('❌ 探针异常:', e); process.exit(1); });
