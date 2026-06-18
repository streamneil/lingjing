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

/** 归一化 OSS region:把误填的完整 endpoint URL 收敛成纯 region 名。
 *  接受 'oss-cn-hangzhou' / 'https://oss-cn-hangzhou.aliyuncs.com' / 'oss-cn-hangzhou.aliyuncs.com'。 */
function normalizeOssRegion(raw: string): string {
  let r = raw.trim();
  if (!r) return '';
  r = r.replace(/^https?:\/\//, ''); // 去协议
  r = r.replace(/\.aliyuncs\.com.*$/, ''); // 去 .aliyuncs.com 及后面
  r = r.replace(/\/.*$/, ''); // 去残留路径
  return r;
}

export const config = {
  port: Number(optional('PORT', '9372')),

  // ── 百炼 / DashScope ──
  baichuan: {
    apiKey: () => required('DASHSCOPE_API_KEY'), // 函数式:仅在真正调用时校验,便于无 key 跑测试
    baseUrl: optional('DASHSCOPE_BASE_URL', 'https://dashscope.aliyuncs.com/api/v1'),
    // 数字人视频模型:音频驱动口型(wan2.2-s2v,吃 image_url + audio_url)。
    avatarModel: optional('BAICHUAN_AVATAR_MODEL', 'wan2.2-s2v'),
    // AI 图片文生图模型(qwen-image,异步,output.results[] 多图数组)。
    imageModel: optional('BAICHUAN_IMAGE_MODEL', 'qwen-image'),
    // AI 图片图生图模型(qwen-image-edit,同步,output.choices[0].message.content[].image)。
    imageEditModel: optional('BAICHUAN_IMAGE_EDIT_MODEL', 'qwen-image-edit'),
    // TTS 模型:文案→音频(CosyVoice,WebSocket)。wan2.2-s2v 不做 TTS,需此前置步骤。
    // ── TTS 全 Qwen-TTS(走 HTTP MultiModalConversation);零 CosyVoice ──
    // 系统音色(预置)默认合成模型。无情绪走 flash,有情绪自动切 instruct(见 worker.resolveVoice)。
    qwenTtsModel: optional('BAICHUAN_QWEN_TTS_MODEL', 'qwen3-tts-flash'),
    // 指令模型:支持 instructions(情绪/音调),系统音色 + 情绪时用它。
    qwenInstructModel: optional('BAICHUAN_QWEN_INSTRUCT_MODEL', 'qwen3-tts-instruct-flash'),
    // 声音复刻(VC):上传样本创建音色 + 用复刻音色合成都用它。target_model 须一致。
    vcModel: optional('BAICHUAN_VC_MODEL', 'qwen3-tts-vc-2026-01-22'),
    // 声音设计(VD):描述→音色。设计 + 用设计音色合成都用它。
    designModel: optional('BAICHUAN_DESIGN_MODEL', 'qwen3-tts-vd-2026-01-26'),
    // AI 音乐(Fun-Music):描述/歌词→歌曲或纯音乐。同步返 output.audio.url(24h)。
    // 邀测 + 仅北京地域,需在模型广场申请开通(未开通返 AccessDenied)。baseUrl 复用 DashScope。
    funMusicModel: optional('BAICHUAN_FUN_MUSIC_MODEL', 'fun-music-v1'),
    // 任务回收模式:'poll'(私有化兜底,默认) | 'webhook'(托管可选)
    jobMode: optional('BAICHUAN_JOB_MODE', 'poll') as 'poll' | 'webhook',
    pollIntervalMs: Number(optional('POLL_INTERVAL_MS', '3000')),
    // worker 任务超时上限(防永久 running 的静默失败,见 eng-review failure mode)
    jobTimeoutMs: Number(optional('POLL_TIMEOUT_MS', '600000')),
    // 文生视频专用超时(eng-review A1):t2v 单条 1-5 分 + 免费档并发=1 排队共享 deadline,
    // 复用 s2v 的 10 分易误杀 → 独立 15 分,留排队+生成双重余量。
    videoT2vTimeoutMs: Number(optional('VIDEO_T2V_TIMEOUT_MS', '900000')),
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

  // 阿里云 OSS:配了 region+bucket 即启用(否则回退本地 MinIO)。
  // wan2.2-s2v 需公网可达的素材 URL —— OSS 公网域名满足,本地 MinIO 不满足。
  // accessKey/secret 复用 DashScope 同账号的 AccessKey(RAM 用户授权 OSS 即可)。
  oss: {
    // region 容错:ali-oss 只认 region 名(如 oss-cn-hangzhou)。用户常误填完整
    // endpoint URL(https://oss-cn-hangzhou.aliyuncs.com),这里归一化成纯 region 名,
    // 否则 ali-oss 启动即抛 "region must be conform" 把整个服务搞崩。
    region: normalizeOssRegion(optional('OSS_REGION', '')),
    bucket: optional('OSS_BUCKET', ''),
    accessKeyId: optional('OSS_ACCESS_KEY_ID', ''),
    accessKeySecret: optional('OSS_ACCESS_KEY_SECRET', ''),
    // 是否启用 OSS:region 与 bucket 都非空时启用
    get enabled(): boolean {
      return !!(this.region && this.bucket && this.accessKeyId && this.accessKeySecret);
    },
  },

  // ── 平台超管引导（/plan-ceo-review D5 + /plan-eng-review B3）──
  // 首次启动 platform_admin 表空时,用这两个 env 建初始超管。
  // user 默认 admin;pass 函数式校验:仅 bootstrap 真要建超管时才 required，
  // 未设则 required() 抛错拒绝启动（绝不用默认口令，否则=后门）。
  // 测试/已建超管的环境不跑 bootstrap，故不会因缺 pass 而崩。
  superadmin: {
    username: optional('SUPERADMIN_USER', 'admin'),
    password: () => required('SUPERADMIN_PASS'),
  },

  // ── worker 并发（2026-06-16 并发改造）──
  worker: {
    // 同时在飞的 job 上限。job 是 I/O 密集（轮询远程厂商，~零 CPU），一个 Node 进程能扛数十个。
    // 真正上限是厂商账号级配额（百炼/火山 RPM/TPM，远高于此），非本机 CPU。默认 16；调更高前先补 429 退避（见 TODOS）。
    poolSize: Math.max(1, Number(optional('WORKER_POOL_SIZE', '16')) || 16),
    // 单租户最大同时在飞 job（公平闸门，防大客户占满整池饿死小客户）。
    // 默认 ceil(poolSize/2)。未来接入套餐分级后，可改为 min(套餐配额, 此值)。
    tenantMaxConcurrent: (() => {
      const pool = Math.max(1, Number(optional('WORKER_POOL_SIZE', '16')) || 16);
      const override = Number(optional('WORKER_TENANT_MAX', ''));
      return override > 0 ? override : Math.ceil(pool / 2);
    })(),
    // 看门狗:queued job 排队超过此时长(且 worker 心跳新鲜=活着却始终没领它)→ 判定卡住,
    // 标 failed + 退预扣(只退不补)。worker 心跳过期(进程死)时不误杀,等重启 recover。默认 15 分钟。
    queuedTimeoutMs: Math.max(60_000, Number(optional('WORKER_QUEUED_TIMEOUT_MS', '')) || 900_000),
  },

  // ── 数据库（Slice1 用 SQLite，够单租户单机；Slice2 多租户可换 Postgres）──
  db: {
    file: optional('DB_FILE', 'lingjing.db'),
  },

  // Slice 1 单租户固定 tenant（Slice2 引入真实多租户后移除）
  defaultTenantId: 'default',
} as const;
