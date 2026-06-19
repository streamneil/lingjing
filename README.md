# 灵镜 Lingjing · 一站式 AIGC 内容创作平台

面向融媒体客户（电视台、报社、政企宣传）与内容团队的**云端 AIGC 创作 SaaS 平台**。
影片、图片、音频三大模态，多个 AI 创作工具，一套积分通用、云端生成、合规可控、支持私有化部署。

> 运行/部署见 `DEPLOY.md` 与 `DEPLOY-ALIYUN.md`；产品规划见 `功能清单-PRD.md`；
> 评审与设计决策见 `~/.gstack/projects/lingjing/`。

---

## 能做什么

| 模态 | 工具 |
|---|---|
| 影片 | **AI 虚拟人**（照片+文案→对口型讲话视频）· **参考生成影片** · **图片转影片** · **文字转影片** · **AI 影片编辑器** |
| 图片 | **AI 图片**（文生图）· **AI 图片编辑器**（图生图/换装/扩图/风格化…） |
| 音频 | **文字转语音**（多音色/克隆/设计音色）· **AI 音乐** |

- **多租户**：平台超管（/admin）开机构 → 机构管理员开账号；租户间数据隔离。
- **积分计费**：reserve（提交预扣）→ settle（成功结算）→ release（失败退还），按真实秒/字/张计价。
- **合规**：AI 生成标识、内容送审、本人授权存证。

## 技术形态

| 项 | 内容 |
|---|---|
| 定位 | 一站式 AIGC 创作 SaaS（融媒体优先），不自建 GPU |
| 算力 | AI 能力全部走云端 API（**阿里云百炼**为主），本机只做编排/轮询/轻量后处理 |
| 后端 | Node + TypeScript（tsx 直跑）· **SQLite**（嵌入式，无外部 DB）· **DB 队列 + 进程内 worker 池**（无 Redis/MQ） |
| 存储 | **阿里云 OSS**（生成素材/成品需公网可达，供百炼拉取） |
| 部署 | **Docker Compose**（Caddy 自动 HTTPS + app 两容器），一台服务器即可；支持私有化交付 |
| 交付 | 双模式：①托管（开账号、按量计费）②私有化（部署到客户内网） |

---

## 快速开始（部署）

详见 **`DEPLOY-ALIYUN.md`**（阿里云 ECS 实战 checklist）。简版：

```bash
git clone https://github.com/streamneil/lingjing.git && cd lingjing
cp .env.example .env && chmod 600 .env   # 填 .env(必填:超管密码/百炼 key/OSS 四项/域名)
./scripts/deploy.sh                       # 一键:校验 → build → up → 等健康
```

- 更新代码：`./scripts/deploy.sh`　仅重启：`./scripts/deploy.sh --restart`
- 数据备份：`./scripts/backup.sh`（SQLite 在线一致备份，可 cron 定时）

> 服务器要求：≥4c8g、amd64、Docker。无 Redis/MySQL/MQ。AI 重算力在百炼云端,不在本机。

---

## 目录结构

```
lingjing/
├── src/                 ← 后端(Node + TS):API / 队列 worker / 网关(百炼/火山) / 存储 / 计费 / 鉴权
├── prototype/           ← 前端页面(HTML/CSS/JS + 共享 shell/app)
├── scripts/             ← 部署/备份/资产生成脚本(deploy.sh / backup.sh / build-showcase-data.mjs …)
├── test/                ← vitest 测试
├── Dockerfile / docker-compose.yml / Caddyfile   ← 容器部署
├── DEPLOY.md / DEPLOY-ALIYUN.md / DEPLOY-PRIVATE.md  ← 部署文档
├── .env.example         ← 环境变量样板(复制为 .env 填值)
└── 功能清单-PRD.md       ← 完整功能规格 / PRD
```

## 本地开发

```bash
npm install
cp .env.example .env     # 本地最少填 SUPERADMIN_PASS + DASHSCOPE_API_KEY;OSS 可选(不配则本机存储回退)
npm run dev              # tsx watch 起服务(默认 :9372)
npm test                # vitest
```

---

## 设计语言

纯黑哑光底（#0A0A0B）+ 炭灰卡片 · 白底黑字 pill 主按钮 · 极简克制、靠灰阶分层 ·
强调色仅小蓝标签 · 毛玻璃 · 字体 Manrope + 思源黑体 + Space Mono。

## 私有化交付

把 `docker-compose.yml` + `.env`（域名换内网域名/自签证书）丢进客户内网即可。
注意：内网下 wan2.2-s2v 的公网素材 URL 问题需单独方案（见 `TODOS.md` T-PUBLIC-URL）。
