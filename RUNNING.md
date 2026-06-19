# 灵镜 Slice 1 — 运行说明

Slice 1 = 单租户、无认证、端到端真视频(预置形象 + 预置音色 + 文案 → 百炼 → DB 队列 → 前端轮询 → 带 AI 标识成品)。
它本身就是可交付给电视台的**私有化 POC**(决策见 `~/.gstack/projects/lingjing/` 设计文档)。

## 架构(Slice 1)

```
浏览器 (prototype/*.html)
   │  POST /api/jobs            GET /api/jobs/:id(轮询)
   ▼
┌─────────────────────────────────────────────┐
│ Express 单体 (src/server.ts)                 │
│   api/jobs.ts ──► queue (job 表=队列)        │
│                      │                        │
│   worker.ts ◄────────┘ claimNextJob (原子领取)│
│      │ moderation 钩子(空实现)              │
│      │ gateway/baichuan (submit→轮询)        │ ──► 阿里百炼
│      │ storage (落素材/成品)                  │ ──► 阿里云 OSS(本地未配则回退 MinIO/本机)
│      ▼ markDone / markFailed(失败隔离)      │
└─────────────────────────────────────────────┘
   DB 为唯一真相,无 SSE,无 Redis。
```

## 本地跑(不用 docker)

需要 Node ≥ 20。

```bash
npm install
cp .env.example .env          # 最少填 SUPERADMIN_PASS + DASHSCOPE_API_KEY
npm run dev                   # http://localhost:9372/  (tsx watch)
```

> 对象存储:本地未配 OSS 时,代码自动回退到本机存储(MinIO,默认 127.0.0.1:9000)。
> 想跑真实数字人生成需配 OSS(百炼要公网可达素材 URL),否则生成会卡 pending。

## docker 部署(生产)

生产用 `docker compose`(Caddy + app,对象存储走阿里云 OSS),见 **`DEPLOY.md` / `DEPLOY-ALIYUN.md`**。

```bash
cp .env.example .env          # 填 .env(超管密码/百炼 key/OSS 四项/域名)
./scripts/deploy.sh           # 一键:校验 → build → up → 等健康
```

## 测试

```bash
npm test          # vitest 全量(含失败隔离 E2E、计价、鉴权等)
npx tsc --noEmit  # 类型检查
```

## 探针(验证百炼能力,跑业务前先跑)

```bash
npm run probe:connect    # 验证 key 有效 + 百炼可达(qwen-turbo)
npm run probe:baichuan   # 打穿数字人链路出第一条视频(需先填 BAICHUAN_AVATAR_MODEL 等)
```

## 还差什么才算 Slice 1 完整(C-research 待补)

这些字段只有百炼控制台开通数字人后才知道,填进 `.env` 即可,代码无需改:
- `BAICHUAN_AVATAR_MODEL` — 数字人视频生成的真实 model 名
- `BAICHUAN_PRESET_AVATAR` — 预置形象 ID
- `src/gateway/baichuan.ts` 里标 `TODO(C-research)` 的 generation 路径 / input 字段 / 成品 URL 字段,以真实 API 文档校准
- AI 标识:C-code 探明成品是否自带;若否,在 worker 第 5 步加 ffmpeg 后处理

## 不在 Slice 1(见设计文档与 TODOS.md)
- 认证 / 多租户 / RBAC → Slice 2
- 积分 / 审计 / 作品库 / 自定义形象上传 / 授权存证 → Slice 3
- 高精训练、支付、歌声迁移 → 推迟/砍掉
