// 灵镜 入口 — Express 应用 + worker。
//
// Slice 1:单进程同时跑 Web 和 worker(单体)。规模化后 worker 可拆独立进程(Approach B)。
// 托管 prototype/ 下的 9 个静态页,create.html 通过轮询接 /api/jobs。

import express from 'express';
import { existsSync } from 'node:fs';
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
import { seedDefaultPlans } from './pricing/index.js';
import { seedPlatformDefaults } from './seed/platform-defaults.js';
import { ordersRouter } from './api/orders.js';
import { paymentsNotifyRouter } from './api/payments.js';
import { adminRouter } from './api/admin.js';
import { captchaRouter } from './api/captcha.js';
import { showcaseRouter } from './api/showcase.js';
import { attachUser, requireApiScope } from './auth/middleware.js';
import { bootstrapSuperadmin } from './auth/platform.js';
import { startWorker } from './queue/worker.js';
import { listPresets } from './voices/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const prototypeDir = resolve(__dirname, '..', 'prototype');

export function createApp() {
  const app = express();
  // 信任前面一层反代(生产 Caddy 终结 TLS 后到 app 是明文 HTTP)。
  // 让 req.protocol / X-Forwarded-Proto 反映原始 HTTPS。仅信一层,防伪造。
  app.set('trust proxy', 1);
  // 支付回调必须挂在 express.json 之前(决策9):微信 v3 验签要原始 body 字节,
  // json parser 一碰就废;支付宝是 form-urlencoded。路由内部用 express.raw 收 Buffer。
  app.use('/api/payments/notify', paymentsNotifyRouter);
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
  // Open API key 作用域守卫:仅约束 viaApiKey 流量(生成面白名单),cookie/公开接口不受影响。
  app.use(requireApiScope);
  app.use('/api', captchaRouter); // 滑块出题/校验(公开,登录前用)
  app.use('/api', showcaseRouter); // 示范素材(公开,落地页登录前用):签名重定向 + 本地兜底
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
  // 首启自动灌默认积分套餐(表空时;幂等,不覆盖运营改过的)。与超管引导同理 —— 让"购买积分套餐"页
  // 开箱即有数据,无论用 deploy.sh 还是裸 docker compose up 起,运营都无需手动到后台加。
  try {
    const seeded = seedDefaultPlans();
    if (seeded > 0) console.log(`[启动] 已自动灌默认积分套餐 ${seeded} 个(/admin 可改价/增删)`);
  } catch (e) {
    console.warn('[启动] 默认积分套餐自动种子失败(不阻断启动):', e instanceof Error ? e.message : e);
  }
  // 首启自动灌平台默认数据(图片/视频模型 + 统一定价 model_pricing,含豆包 Seedream/Gemini;表空时、幂等)。
  // image-models 的 isEnabled 要求 DB 行,无行则「AI 图片/编辑器」下拉"暂无可用模型"。生产 deploy.sh
  // 不跑 seed-demo,故在此自灌兜底(与默认积分套餐同理)。
  try {
    const r = seedPlatformDefaults();
    if (r.image || r.video || r.pricing)
      console.log(`[启动] 已自动灌平台默认数据:图片模型 ${r.image}、视频档 ${r.video}、统一定价 ${r.pricing} 行(/admin 可改价/启停)`);
  } catch (e) {
    console.warn('[启动] 平台默认数据自动种子失败(不阻断启动):', e instanceof Error ? e.message : e);
  }
  // OSS 未配齐告警(Docker 部署就绪 D15):wan2.2-s2v 需公网可达素材 URL,
  // 内网 minio 百炼访问不到。没配 OSS 时生成会卡 pending 超时,这里早告警而非运行时才暴雷。
  if (!config.oss.enabled) {
    console.warn(
      '[警告] OSS 未配齐(OSS_REGION/BUCKET/ACCESS_KEY_ID/ACCESS_KEY_SECRET)。' +
        '托管部署下数字人生成需公网可达素材 URL,内网 MinIO 百炼访问不到 → 生成会卡 pending 超时。' +
        '生产请在 .env 配置 OSS。',
    );
  }
  // 预置音色试听样本自检:小样随 git 进 prototype/showcase/voices/(去中心化,见 voices/index.ts +
  // src/api/showcase.ts)。启动时查镜像内是否带这些文件 —— 缺了说明 LFS 未拉取(checkout 只有指针),
  // 前端试听 + seed 都会失败,早告警。非阻塞;只查第一个预置(代表整批)。
  void (async () => {
    try {
      const first = listPresets()[0];
      if (!first) return;
      const diskPath = resolve(prototypeDir, 'showcase', 'voices', `${first.id}.wav`);
      if (!existsSync(diskPath)) {
        console.warn(
          `[警告] 预置音色试听样本缺失(${diskPath})。多半是 checkout 不完整(prototype/showcase/ 媒体未拉全)。` +
            '前端「试听」与 seed-showcase 会失败。修:确认 `git status` 干净并完整 checkout,' +
            '再重新 build 镜像;私有化离线场景请确保镜像内自带 prototype/showcase/ 媒体。',
        );
      }
    } catch {
      /* 探测失败不阻塞启动 */
    }
  })();

  const app = createApp();
  startWorker();
  // 订单/在线支付统一 sweep(每分钟):过期在线码先查单(已付→入账,私有化内网无回调时
  // 这是唯一入账路径)再关单;对公超时单自动取消。sweepOrders 自带重入守卫(决策13/27)。
  void (async () => {
    const { sweepOrders } = await import('./orders/index.js');
    const sweep = () => {
      void sweepOrders()
        .then((n) => { if (n) console.log(`[订单] 待支付超时自动取消 ${n} 单`); })
        .catch((e) => console.warn('[订单] sweep 异常(下轮重试):', e instanceof Error ? e.message : e));
    };
    sweep();
    setInterval(sweep, 60_000).unref?.();
  })();
  // 每日对账(决策 D4.3):每小时检查昨日账单是否已对平,未对/账单未生成则重试(recon_run 幂等)。
  void (async () => {
    const { reconTick } = await import('./payments/recon.js');
    const tick = () => {
      void reconTick().catch((e) => console.warn('[对账] tick 异常(下轮重试):', e instanceof Error ? e.message : e));
    };
    setTimeout(tick, 30_000).unref?.(); // 启动 30s 后首查(避开启动高峰)
    setInterval(tick, 60 * 60_000).unref?.();
  })();
  app.listen(config.port, () => {
    console.log(`灵镜启动: http://localhost:${config.port}`);
    console.log(`  worker: 已启动(DB 队列轮询)`);
  });
  })();
}
