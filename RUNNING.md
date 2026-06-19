# 灵镜 — 运行说明

灵镜是一站式 AIGC 创作平台(影片/图片/音频三模态、多工具),多租户 + 积分计费 + 合规可控。
本文讲怎么把它跑起来。部署见 `DEPLOY.md` / `DEPLOY-ALIYUN.md`;产品规格见 `功能清单-PRD.md`。

## 架构

```
浏览器 (prototype/*.html)
   │  POST /api/jobs            GET /api/jobs/:id(轮询)
   ▼
┌─────────────────────────────────────────────┐
│ Express 单体 (src/server.ts)                 │
│   api/* ──► queue(job 表 = 队列)            │  鉴权/admin/积分/计费/订单…
│                      │                        │
│   worker.ts ◄────────┘ claimNextJob(原子领取)│  N 槽并发池
│      │ 送审钩子 → gateway(submit→轮询)      │ ──► 阿里百炼 / 火山方舟
│      │ ffmpeg(拼接/AI 标识) → storage        │ ──► 阿里云 OSS(本地未配则回退本机)
│      ▼ markDone / markFailed(失败隔离)      │
└─────────────────────────────────────────────┘
   DB(SQLite)为唯一真相;队列在 DB,无 Redis/MQ;前端轮询,无 SSE。
```

- **无外部中间件**:SQLite 嵌入式库 + 进程内 worker 池。AI 重算力全在云端(百炼/火山),本机只做编排/轮询/ffmpeg 轻量后处理。
- **多 provider**:百炼(数字人 s2v / Qwen-TTS / Qwen 图片 / Fun-Music)+ 火山方舟(Seedance/Seedream)。key 走加密网关(库内密文优先,回落 .env)。

## 本地跑(不用 docker)

需要 Node ≥ 20。

```bash
npm install
cp .env.example .env          # 最少填 SUPERADMIN_PASS + DASHSCOPE_API_KEY
npm run dev                   # http://localhost:9372/  (tsx watch)
```

> 对象存储:本地未配 OSS 时,代码自动回退到本机存储(MinIO 客户端,默认 127.0.0.1:9000)。
> 想跑真实数字人/视频生成需配 OSS(百炼要公网可达素材 URL),否则生成会卡 pending。

## docker 部署(生产)

生产用 `docker compose`(Caddy 自动 HTTPS + app 两容器,对象存储走阿里云 OSS),详见 **`DEPLOY-ALIYUN.md`**。

```bash
cp .env.example .env          # 填 .env(超管密码 / 百炼 key / OSS 四项 / 域名)
./scripts/deploy.sh           # 一键:校验 → build → up → 等健康
```

## 首次使用(冷启动)

全新部署 DB 为空,只有平台超管:开 `https://你的域名/admin/login` 用 `admin` / `<SUPERADMIN_PASS>`
登录 → 「新建租户」建机构 → 「开户」建机构管理员 → 机构用户去 `/login.html` 登录创作台。

## 测试 / 质检

```bash
npm test          # vitest 全量(含失败隔离 E2E、计价、鉴权、配额等)
npx tsc --noEmit  # 类型检查
```

## 探针(验证云端能力,跑业务前可先跑)

```bash
npm run probe:connect    # 验证 key 有效 + 百炼可达
npm run probe:baichuan   # 打穿数字人链路出第一条视频
```
