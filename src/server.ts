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
import { assetsRouter } from './api/assets.js';
import { settingsRouter } from './api/settings.js';
import { attachUser } from './auth/middleware.js';
import { startWorker } from './queue/worker.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const prototypeDir = resolve(__dirname, '..', 'prototype');

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // 每个请求先解析 session 挂 req.user(不强制),路由各自决定是否要求登录/角色。
  app.use(attachUser);
  app.use('/api', authRouter);
  app.use('/api', creditsRouter);
  app.use('/api', avatarsRouter);
  app.use('/api', voicesRouter);
  app.use('/api', assetsRouter);
  app.use('/api', settingsRouter);
  app.use('/api', jobsRouter);

  // 静态页:prototype 直接托管(Slice1 复用高保真原型作为 UI)
  app.use('/', express.static(prototypeDir));

  return app;
}

// 直接运行(非测试导入)时启动服务 + worker
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const app = createApp();
  startWorker();
  app.listen(config.port, () => {
    console.log(`灵镜 Slice1 启动: http://localhost:${config.port}`);
    console.log(`  形象库首页: http://localhost:${config.port}/index.html`);
    console.log(`  worker: 已启动(DB 队列轮询)`);
  });
}
