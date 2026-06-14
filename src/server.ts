// 灵镜 入口 — Express 应用 + worker。
//
// Slice 1:单进程同时跑 Web 和 worker(单体)。规模化后 worker 可拆独立进程(Approach B)。
// 托管 prototype/ 下的 9 个静态页,create.html 通过轮询接 /api/jobs。

import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config } from './config.js';
import { jobsRouter } from './api/jobs.js';
import { authRouter } from './api/auth.js';
import { creditsRouter } from './api/credits.js';
import { avatarsRouter } from './api/avatars.js';
import { voicesRouter } from './api/voices.js';
import { settingsRouter } from './api/settings.js';
import { legalRouter } from './api/legal.js';
import { pricingRouter } from './api/pricing.js';
import { ordersRouter } from './api/orders.js';
import { adminRouter } from './api/admin.js';
import { captchaRouter } from './api/captcha.js';
import { attachUser } from './auth/middleware.js';
import { bootstrapSuperadmin } from './auth/platform.js';
import { startWorker } from './queue/worker.js';
import { listPresets, presetSampleKey } from './voices/index.js';
import { storage } from './storage/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const prototypeDir = resolve(__dirname, '..', 'prototype');

export function createApp() {
  const app = express();
  // 信任前面一层反代(生产 Caddy 终结 TLS 后到 app 是明文 HTTP)。
  // 让 req.protocol / X-Forwarded-Proto 反映原始 HTTPS。仅信一层,防伪造。
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // ── 平台超管(/admin):挂在全局 attachUser 之前,且 adminRouter 自身不挂 attachUser。
  // 故 req.user 在 /admin 链路永远 undefined(E-1.1 结构隔离)。requirePlatformAdmin 只认
  // lj_padmin —— 租户拿 lj_session 打 /admin/* 也只会 401。
  app.use('/admin', adminRouter);

  // 每个请求先解析 session 挂 req.user(不强制),路由各自决定是否要求登录/角色。
  // 注意:attachUser 不再全局挂(E-1.1)—— 它只覆盖 /admin 之后注册的租户路由与静态页;
  // /admin 已在上面注册,不会经过 attachUser。
  app.use(attachUser);
  app.use('/api', captchaRouter); // 滑块出题/校验(公开,登录前用)
  app.use('/api', authRouter);
  app.use('/api', creditsRouter);
  app.use('/api', avatarsRouter);
  app.use('/api', voicesRouter);
  app.use('/api', settingsRouter);
  app.use('/api', legalRouter);
  app.use('/api', pricingRouter);
  app.use('/api', ordersRouter);
  app.use('/api', jobsRouter);

  // 根路径 → 营销落地页(公开入口);旧 index.html 已改名 avatars.html
  app.get('/', (_req, res) => res.redirect('/landing.html'));

  // 静态页:prototype 直接托管(Slice1 复用高保真原型作为 UI)。
  // 但屏蔽 prototype/admin/ —— 超管页只由 adminRouter sendFile 提供于 /admin/,
  // 不让 express.static 在 /admin/* 直接吐文件(E-1.2:不暴露顶层超管页路径)。
  app.use('/', (req, res, next) => {
    if (req.path === '/admin' || req.path.startsWith('/admin/')) return next();
    return express.static(prototypeDir)(req, res, next);
  });

  return app;
}

// 直接运行(非测试导入)时启动服务 + worker
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  void (async () => {
  await bootstrapSuperadmin(); // 首启建初始超管(无 SUPERADMIN_PASS 在此抛错拒启;bcrypt 异步)
  // OSS 未配齐告警(Docker 部署就绪 D15):wan2.2-s2v 需公网可达素材 URL,
  // 内网 minio 百炼访问不到。没配 OSS 时生成会卡 pending 超时,这里早告警而非运行时才暴雷。
  if (!config.oss.enabled) {
    console.warn(
      '[警告] OSS 未配齐(OSS_REGION/BUCKET/ACCESS_KEY_ID/ACCESS_KEY_SECRET)。' +
        '托管部署下数字人生成需公网可达素材 URL,内网 MinIO 百炼访问不到 → 生成会卡 pending 超时。' +
        '生产请在 .env 配置 OSS。',
    );
  }
  // 预置音色试听样本自检:存储里缺样本(没跑过 seed)→ 前端试听会 404,这里启动时早告警。
  // 非阻塞、容错(探测失败不影响启动);只探第一个预置(代表整批,省一次性 IO)。
  void (async () => {
    try {
      const first = listPresets()[0];
      if (!first) return;
      const buf = await storage.getObject(presetSampleKey(first.id)).catch(() => null);
      if (!buf || buf.length === 0) {
        console.warn(
          '[警告] 预置音色试听样本缺失(存储里没有 voices/presets/*.mp3)。' +
            '前端「试听」预置音色会失败。请在配好存储 + DASHSCOPE_API_KEY 后运行一次种子脚本:' +
            '  DASHSCOPE_API_KEY=sk-xxx npx tsx scripts/seed-preset-samples.mjs  (幂等,可重复跑)',
        );
      }
    } catch {
      /* 探测失败不阻塞启动 */
    }
  })();

  const app = createApp();
  startWorker();
  app.listen(config.port, () => {
    console.log(`灵镜启动: http://localhost:${config.port}`);
    console.log(`  worker: 已启动(DB 队列轮询)`);
  });
  })();
}
