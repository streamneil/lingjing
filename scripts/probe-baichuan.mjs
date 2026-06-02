#!/usr/bin/env node
// 灵镜 C-code 探针 — 验证百炼真实链路的 go/no-go
//
// 目标(对应 /plan-eng-review 决策 D2/D5/D7 + 外部声音 #4):
//   1. 打穿一条真实链路:文案 → 百炼数字人视频,出第一条真视频
//   2. 探明异步回收机制(确认 poll;百炼数字人/视频是 submit→轮询 task_status 范式)
//   3. 探明 AI 生成标识:是百炼输出自带、还是需我方 ffmpeg 后处理
//   4. 测出端到端时延(决定 worker 超时上限 + 用户等待体验)
//
// 用法:
//   1. 复制 .env.example 为 .env,填入你开通的百炼凭证(密钥不要贴聊天/不要提交 git)
//   2. node scripts/probe-baichuan.mjs
//
// 注意:本文件是骨架。百炼数字人具体的 model 名、入参字段(形象 ID / 音色 / 文案)
// 需以你账号开通后控制台给出的 API 文档为准 —— 标了 TODO(C-research) 的地方按真实接口补。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ---- 极简 .env 读取(不引依赖,探针阶段够用)----
function loadEnv() {
  try {
    const raw = readFileSync(resolve(process.cwd(), '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    console.error('⚠️  没找到 .env。复制 .env.example 为 .env 并填入百炼凭证后重试。');
    process.exit(1);
  }
}
loadEnv();

const API_KEY = process.env.DASHSCOPE_API_KEY;
if (!API_KEY) {
  console.error('⚠️  缺少 DASHSCOPE_API_KEY(百炼 API Key)。填进 .env 后重试。');
  process.exit(1);
}

// 百炼 DashScope 兼容端点(异步任务通用基址)。具体模型路径以你的开通文档为准。
const BASE = process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/api/v1';

const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

async function http(method, path, body, extraHeaders = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  return { status: res.status, json };
}

// ---- 1. 提交数字人视频生成任务 ----
// TODO(C-research): 确认数字人视频生成的真实 model 名与入参 schema。
//   下面用 ASYNC 头提交,这是百炼异步任务范式(参考 VideoSynthesis / ImageSynthesis)。
async function submitVideoTask() {
  const model = process.env.BAICHUAN_AVATAR_MODEL || 'PLACEHOLDER-数字人模型名-待开通后填';
  const body = {
    model,
    input: {
      // TODO(C-research): 真实字段名以接口为准。常见形态:形象 ID + 文案/音频驱动。
      avatar: process.env.BAICHUAN_PRESET_AVATAR || 'PLACEHOLDER-预置形象ID',
      text: '大家好,这里是测试播报。灵镜数字人链路探针。',
      voice: process.env.BAICHUAN_PRESET_VOICE || 'cosyvoice-v1',
    },
    parameters: { resolution: '1080P', ratio: '16:9' },
  };
  console.log(`[${elapsed()}] 提交视频任务 model=${model} ...`);
  // X-DashScope-Async: enable → 走异步任务,返回 task_id(这是 D2 确认的 poll 范式)
  const r = await http('POST', '/services/aigc/video-generation/generation', body, {
    'X-DashScope-Async': 'enable',
  });
  console.log(`[${elapsed()}] 提交响应 status=${r.status}`);
  console.dir(r.json, { depth: 4 });
  const taskId = r.json?.output?.task_id;
  if (!taskId) {
    console.error('❌ 没拿到 task_id。检查 model 名/字段(C-research 待补),或看上面错误。');
    process.exit(2);
  }
  return taskId;
}

// ---- 2. 轮询任务状态(D2 确认:百炼原生 poll)----
async function pollTask(taskId) {
  const intervalMs = Number(process.env.POLL_INTERVAL_MS || 3000);
  const timeoutMs = Number(process.env.POLL_TIMEOUT_MS || 10 * 60 * 1000); // worker 超时上限的探测值
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await http('GET', `/tasks/${taskId}`);
    const status = r.json?.output?.task_status;
    console.log(`[${elapsed()}] 轮询 task_status=${status}`);
    if (status === 'SUCCEEDED') return r.json;
    if (status === 'FAILED' || status === 'CANCELED') {
      console.error('❌ 任务失败:', JSON.stringify(r.json?.output));
      process.exit(3);
    }
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  console.error(`❌ 轮询超时(${timeoutMs}ms)。这个值就是 worker 任务超时上限的参考。`);
  process.exit(4);
}

// ---- 主流程 + 未知数报告 ----
(async () => {
  console.log('=== 灵镜 C-code 探针:百炼数字人链路 go/no-go ===\n');
  const taskId = await submitVideoTask();
  const result = await pollTask(taskId);
  const videoUrl = result?.output?.video_url || result?.output?.results?.[0]?.url;

  console.log('\n=== 探针报告(填进设计文档 C-code 结论)===');
  console.log(`✅ 端到端耗时: ${elapsed()}  → worker 超时上限至少设到这个值的 2-3 倍`);
  console.log(`✅ 异步机制: POLL(已确认,百炼 submit→轮询 task_status 范式)`);
  console.log(`   webhook 是否也支持? → 查开通文档是否有回调配置(私有化内网用 poll 兜底)`);
  console.log(`📹 视频 URL: ${videoUrl || '未解析到,检查 output 结构 ↑'}`);
  console.log(`\n❓ 待人工判断(下载视频后看):`);
  console.log(`   - AI 标识:成品是否自带显式水印/标识? 没有→需我方 ffmpeg 后处理(决策 D5)`);
  console.log(`   - 口型同步无明显错位? 形象可辨识? 无恐怖谷? → 3 人盲评(验收"够震"门槛)`);
  console.log(`   - 保真度是否足以打动那家电视台? → TODOS.md T-FIDELITY`);
})().catch((e) => {
  console.error('❌ 探针异常:', e);
  process.exit(1);
});
