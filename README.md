# 灵镜 Lingjing · 一站式 AIGC 内容创作平台

面向融媒体客户（电视台、报社、政企宣传）与内容团队的**云端 AIGC 创作 SaaS 平台**。
影片、图片、音频三大模态，多个 AI 创作工具，一套积分通用、云端生成、合规可控、支持私有化部署。

> 运行见 `RUNNING.md`；部署见 `DEPLOY.md` / `DEPLOY-ALIYUN.md`（阿里云）/ `DEPLOY-PRIVATE.md`（私有化）；
> 产品规格见 `功能清单-PRD.md`。

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

## 生产部署（阿里云服务器）

完整清单见 **`DEPLOY-ALIYUN.md`**。最短路径:

```bash
# 1. 服务器装 Docker(见 DEPLOY-ALIYUN.md §2),然后:
git clone https://github.com/streamneil/lingjing.git && cd lingjing

# 2. 配 .env(只填 5 类:超管密码 / MASTER_KEY / OSS 四项 / 域名;厂商 key 不填这里)
cp .env.example .env && chmod 600 .env

# 3. 一键部署:校验 → build(媒体随镜像)→ up → 等健康 → 灌示范素材到你的 OSS
#    (积分套餐由 app 启动自动种子;示范图文/音色/视频随仓自带,无外部桶依赖)
./scripts/deploy.sh

# 4. 浏览器开 https://你的域名/admin/login(admin / SUPERADMIN_PASS)
#    →「厂商 / Key」配百炼/火山/Google 的 API Key → 新建租户 → 开户
#    平台即可用。落地页/灵感/示范数据已自带(见「数据完整性」)。
```

- 更新代码:`./scripts/deploy.sh`　仅重启:`./scripts/deploy.sh --restart`
- 数据备份:`./scripts/backup.sh`(SQLite 在线一致备份,可 cron 定时)

> 服务器要求:≥4c8g、amd64、Docker。无 Redis/MySQL/MQ。AI 重算力在云端(百炼/火山),不在本机。

### 部署后只需配这些(其余开箱即用)

| 配在哪 | 配什么 |
|---|---|
| **`.env`(部署前)** | 超管密码 `SUPERADMIN_PASS`、主密钥 `MASTER_KEY`(`openssl rand -base64 32`)、OSS 四项、域名 |
| **`/admin`(部署后)** | 厂商 API Key:**百炼 / 火山方舟 / Google AI Studio**,在「厂商 / Key」页粘贴(加密入库) |

`MASTER_KEY` 是解密库内厂商 key 的总钥匙,只能走 `.env`;没它后台贴 key 会失败。
厂商 key 一律在 `/admin` 配,`.env` 里不写任何厂商 key。

### 数据完整性:为什么部署后不用手动整理示范数据

平台「开箱即数据完整」,**运营无需手工整理,也不依赖任何外部桶**(去中心化:每个部署自包含):

| 数据 | 来源 | 部署后 |
|---|---|---|
| 落地页/探索灵感的**图文、示范素材**(果茶广告、AI 音乐示例等)、预置形象/声音 | 媒体**随 git 入库**(`prototype/showcase/`)→ 进 Docker 镜像 → `deploy.sh` 自动 seed 到运营**自己的 OSS**;前端走 `/api/showcase-asset`(签名重定向自己桶 / 桶里没有则伺服镜像内文件兜底) | ✅ 自动就有,零外部依赖;空桶/内网/air-gap 也完整显示 |
| **默认积分套餐** | app **启动时自动种子**(`seedDefaultPlans`,表空才灌、幂等);裸 `docker compose up` 也生效 | ✅ 自动有 4 个默认套餐,`/admin` 可改价/增删 |
| **预置音色 + 试听小样** | 音色元数据随代码;20 个试听 WAV 随 git 入库,同走 `/api/showcase-asset` | ✅ 自动有,试听直接出声(无需配百炼/跑脚本) |

> **去中心化要点**:示范媒体不再引用任何公共桶,改为随仓库 → 镜像 → 运营自己的 OSS。
> 一台部署的素材完全在自己掌控内,公共桶下线/迁移都不影响你;私有化内网同样开箱即完整。
> 运营**生成的内容**写进 `.env` 配的 `OSS_BUCKET`,与示范素材(`showcase/` 前缀)同桶不同前缀、互不干扰。
> 预置形象的**视频生成源帧**例外:经发布策略(托管=签名直链;私有化见 `TODOS.md` T-PUBLIC-URL)保证百炼可拉。

---

## 目录结构

```
lingjing/
├── src/                 ← 后端(Node + TS):API / 队列 worker / 网关(百炼/火山) / 存储 / 计费 / 鉴权
├── prototype/           ← 前端页面(HTML/CSS/JS + 共享 shell/app)
├── scripts/             ← 部署/运维脚本(deploy.sh / dev-up.sh / backup.sh / seed-platform.mjs …)
├── test/                ← vitest 测试
├── Dockerfile / docker-compose.yml / Caddyfile   ← 容器部署
├── DEPLOY.md / DEPLOY-ALIYUN.md / DEPLOY-PRIVATE.md  ← 部署文档
├── .env.example         ← 环境变量样板(复制为 .env 填值)
└── 功能清单-PRD.md       ← 完整功能规格 / PRD
```

## 本地开发

**一键起(推荐)** —— 清理旧进程 → 种子 demo 账号 + 默认套餐 → 起服务 → 健康检查:

```bash
npm install
cp .env.example .env     # 本地最少填 SUPERADMIN_PASS + MASTER_KEY(贴 key 用);OSS 建议配(否则生成卡住)
./scripts/dev-up.sh      # 起在 http://localhost:9372/
# 登录:demoadmin / pw123456(机构管理员)| admin / <SUPERADMIN_PASS>(平台超管)
# 厂商 key:开 /admin →「厂商 / Key」贴百炼等 key 即可生成
```

**手动起(只起服务)**:

```bash
npm run dev                                  # tsx watch 起服务(默认 :9372;启动自动灌默认积分套餐)
npm test                                     # vitest 全量
```

> **零 OSS 也能开箱即用**:不配 `OSS_*` 时,示范素材(落地页/探索/试听/形象/参考生成影片)走
> `/api/showcase-asset` 的**本地磁盘兜底**(媒体随仓在 `prototype/showcase/`),新克隆同事直接
> `./scripts/dev-up.sh` 就能看全。只有"真实生成"(数字人视频等)才需 OSS + 厂商 key。
> 本地 `OSS_BUCKET` 建议用自己的开发桶(别和生产共用)。

---

## 设计语言

纯黑哑光底（#0A0A0B）+ 炭灰卡片 · 白底黑字 pill 主按钮 · 极简克制、靠灰阶分层 ·
强调色仅小蓝标签 · 毛玻璃 · 字体 Manrope + 思源黑体 + Space Mono。

## 私有化交付

把镜像 + `docker-compose.yml` + `.env`（域名换内网域名/自签证书）丢进客户内网即可。
**示范素材随镜像自带**(去中心化),内网/air-gap **开箱即完整显示**(走 `/api/showcase-asset`
本地兜底),不依赖任何外网公共桶。
注意:仅"真实生成"(wan2.2-s2v 等)需让百炼能拉到公网素材 URL,内网下需单独方案
(见 `TODOS.md` T-PUBLIC-URL);示范素材的"显示"不受此限。
