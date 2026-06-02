// 灵镜 配置层 — 集中读取环境变量,缺关键项时尽早失败(explicit > clever)。
//
// Slice 1 是单租户:百炼凭证从平台 .env 读。
// Slice 2 多租户时,凭证改为 per-tenant 从 DB 读(能力网关已为此预留切换点)。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// 极简 .env 加载:不引 dotenv,避免 Slice1 多一个依赖。已存在的真实 env 优先。
function loadDotEnv(): void {
  try {
    const raw = readFileSync(resolve(process.cwd(), '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && m[1] && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2]!.replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    // 无 .env 不报错:生产/容器里走真实环境变量注入。
  }
}
loadDotEnv();

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`缺少必需环境变量 ${key}（见 .env.example）`);
  return v;
}
function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const config = {
  port: Number(optional('PORT', '9372')),

  // ── 百炼 / DashScope ──
  baichuan: {
    apiKey: () => required('DASHSCOPE_API_KEY'), // 函数式:仅在真正调用时校验,便于无 key 跑测试
    baseUrl: optional('DASHSCOPE_BASE_URL', 'https://dashscope.aliyuncs.com/api/v1'),
    // 数字人视频模型:音频驱动口型(wan2.2-s2v,吃 image_url + audio_url)。
    avatarModel: optional('BAICHUAN_AVATAR_MODEL', 'wan2.2-s2v'),
    // TTS 模型:文案→音频(CosyVoice,WebSocket)。wan2.2-s2v 不做 TTS,需此前置步骤。
    ttsModel: optional('BAICHUAN_TTS_MODEL', 'cosyvoice-v2'),
    // 任务回收模式:'poll'(私有化兜底,默认) | 'webhook'(托管可选)
    jobMode: optional('BAICHUAN_JOB_MODE', 'poll') as 'poll' | 'webhook',
    pollIntervalMs: Number(optional('POLL_INTERVAL_MS', '3000')),
    // worker 任务超时上限(防永久 running 的静默失败,见 eng-review failure mode)
    jobTimeoutMs: Number(optional('POLL_TIMEOUT_MS', '600000')),
  },

  // ── MinIO（S3 兼容，托管/私有化同构）──
  minio: {
    endPoint: optional('MINIO_ENDPOINT', '127.0.0.1'),
    port: Number(optional('MINIO_PORT', '9000')),
    useSSL: optional('MINIO_USE_SSL', 'false') === 'true',
    accessKey: optional('MINIO_ACCESS_KEY', 'minioadmin'),
    secretKey: optional('MINIO_SECRET_KEY', 'minioadmin'),
    bucket: optional('MINIO_BUCKET', 'lingjing'),
  },

  // ── 数据库（Slice1 用 SQLite，够单租户单机；Slice2 多租户可换 Postgres）──
  db: {
    file: optional('DB_FILE', 'lingjing.db'),
  },

  // Slice 1 单租户固定 tenant（Slice2 引入真实多租户后移除）
  defaultTenantId: 'default',
} as const;
