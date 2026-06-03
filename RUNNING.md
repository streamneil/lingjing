# 灵镜 Slice 1 — 运行说明

Slice 1 = 单租户、无认证、端到端真视频(预置形象 + 预置音色 + 文案 → 百炼 → DB 队列 → 前端轮询 → 带 AI 标识成品)。
它本身就是可交付给电视台的**私有化 POC**(决策见 `~/.gstack/projects/digital-human/` 设计文档)。

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
│      │ storage/minio (落成品)                │ ──► MinIO
│      ▼ markDone / markFailed(失败隔离)      │
└─────────────────────────────────────────────┘
   DB 为唯一真相,无 SSE,无 Redis。
```

## 本地跑(不用 docker)

需要 Node ≥ 20。

```bash
npm install
cp .env.example .env          # 填入 DASHSCOPE_API_KEY(已开通付费)
# MinIO:本地单独起一个,或用 docker 只起 minio:
docker compose up -d minio
npm run dev                   # http://localhost:9372/index.html
```

## docker 一键起(app + MinIO)

```bash
cp .env.example .env          # 填 key
docker compose up --build
# 形象库首页: http://localhost:9372/index.html
# MinIO 控制台: http://localhost:9001 (minioadmin/minioadmin)
```

## 测试

```bash
npm test          # 12 个测试,含失败隔离 E2E(护城河卵论点)
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
