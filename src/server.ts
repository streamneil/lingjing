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
import { adminRouter } from './api/admin.js';
import { captchaRouter } from './api/captcha.js';
import { attachUser } from './auth/middleware.js';
import { bootstrapSuperadmin } from './auth/platform.js';
import { startWorker } from './queue/worker.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const prototypeDir = resolve(__dirname, '..', 'prototype');

export function createApp() {
  const app = express();
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
  bootstrapSuperadmin(); // 首启建初始超管(无 SUPERADMIN_PASS 在此抛错拒启)
  const app = createApp();
  startWorker();
  app.listen(config.port, () => {
    console.log(`灵镜 Slice1 启动: http://localhost:${config.port}`);
    console.log(`  形象库首页: http://localhost:${config.port}/index.html`);
    console.log(`  worker: 已启动(DB 队列轮询)`);
  });
}
