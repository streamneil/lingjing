# 灵镜 Lingjing · 一站式 AIGC 内容创作平台

面向融媒体客户（电视台、报社、政企宣传）与内容团队的**云端 AIGC 创作 SaaS 平台**。
影片、图片、音频三大模态，多个 AI 创作工具，一套积分通用、云端生成、合规可控、支持私有化部署。

> 运行见 `RUNNING.md`；部署见 `DEPLOY.md` / `DEPLOY-ALIYUN.md`（阿里云）/ `DEPLOY-PRIVATE.md`（私有化）；
> 产品规格见 `功能清单-PRD.md`；在线支付运维排障见 `docs/PAYMENTS-RUNBOOK.md`；
> 用户可见变更见 `CHANGELOG.md`；待办与评审结论见 `TODOS.md`。

---

## 能做什么

| 模态 | 工具 |
|---|---|
| 影片 | **AI 虚拟人**（照片+文案→对口型讲话视频）· **参考生成影片** · **图片转影片** · **文字转影片** · **AI 影片编辑器** |
| 图片 | **AI 图片**（文生图）· **AI 图片编辑器**（图生图/换装/扩图/风格化…） |
| 音频 | **文字转语音**（多音色/克隆/设计音色）· **AI 音乐** |

- **多租户**：平台超管（/admin）开机构 → 机构管理员开账号；租户间数据隔离。
- **积分计费**：reserve（提交预扣）→ settle（成功结算）→ release（失败退还），按真实秒/字/张计价。
- **在线收款**：充值支持微信支付 / 支付宝（秒级自动到账、原路退款、每日自动对账）与对公转账；商户号/密钥在 `/admin →「在线支付」`加密配置。
- **合规**：AI 生成标识、内容送审、本人授权存证。
- **开放接口**：REST API + **MCP**，让客户自己的 AI Agent 直接调用平台能力（见下）。

## 给 AI Agent 用（开放 API / MCP）

机构成员在 `系统设置 → API 密钥` 建一把 `lj_sk_…`，就能让 Claude Code、Cursor 等 Agent 直接调用平台。
密钥**等同于创建它的那个成员本人** —— 权限、计费、作品归属都和这个人在网页上操作一致。

**MCP（推荐，Agent 生态的事实标准）** —— 在 Agent 里加一段配置即可：

```json
{ "mcpServers": { "lingjing": {
  "type": "http",
  "url": "https://你的域名/mcp",
  "headers": { "Authorization": "Bearer lj_sk_..." }
} } }
```

连上后 Agent 自动获得 16 个在用工具(另有一个已废弃的 estimate)与一份使用说明，覆盖**除数字人口播外的全部创作能力**：

| 类别 | 工具 |
|---|---|
| 上传 | `upload_image` · `upload_video` · `upload_audio` |
| 生成 | `generate_image` · `generate_video` · `generate_video_from_image` · `generate_video_from_refs` · `edit_video` · `generate_music` · `generate_speech` |
| 查询 | `get_job` · `list_jobs` · `get_balance` |
| 发现 | `list_models` · `list_voices` · `list_avatars` |

- 生成类全异步：返回 `job_id`，用 `get_job` 轮询（间隔 ≥5 秒）。
- **先问价**：任意 `generate_*` 传 `dry_run: true` 只返回预估费用与余额，不扣分；它与真提交共用同一套校验，通过即代表提交也会通过。
- **重试不双扣**：传相同的 `idempotency_key` 即可。
- **做不到的事**：数字人口播视频、创建数字人形象、声音克隆/设计音色 —— 强合规链路，只能在后台网页端完成（Agent 会从 `instructions` 读到这一点，不会瞎试）。
- 大文件（>20MB 视频）改走 REST `POST /api/video-uploads`，同一把密钥。

**REST** —— 同一把密钥，`POST /api/jobs` 用 `type` 区分工具。完整文档见站内 `/api-docs.html`（含错误码表、限速、幂等）。

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

> 服务器要求:≥4c8g、amd64、Docker。无 Redis/MySQL/MQ。AI 重算力在云端(百炼/火山),不在本机。

### 运维速查(部署 / 更新 / 重启 / 备份 / 日志)

| 操作 | 命令 |
|---|---|
| 首次部署 / 更新代码(git 部署) | `./scripts/deploy.sh`(git pull → 重建 → 等健康 → 灌示范素材) |
| 按现有文件重建(scp/rsync 部署) | `./scripts/deploy.sh --no-pull`(跳过 git pull,直接重建) |
| 只重启 app(不拉码、不重建) | `./scripts/deploy.sh --restart` |
| 看实时日志 | `docker compose logs -f app` |
| 数据备份(SQLite 在线一致) | `./scripts/backup.sh`(可挂 cron 定时) |
| 手动补灌示范素材到 OSS(幂等) | `docker compose exec app npx tsx scripts/seed-showcase.mjs` |

> `deploy.sh` 任一步失败即退出(`set -e`),不留半拉子状态;示范素材灌桶失败**只告警不阻断**
> (端点会回退伺服镜像内文件,站点照常显示)。积分套餐由 app 启动自动种子,无需手动跑。

#### 两种部署方式 → 对应的更新姿势

**镜像是本机现编的**:`deploy.sh` 跑 `docker compose up -d --build`,按 `Dockerfile`(`npm ci` +
`COPY . .` 把代码和 `prototype/showcase/` 媒体烤进镜像)编出 `lingjing-app` 镜像。**改了代码必须重建,
否则跑的还是旧镜像**(`docker compose restart` / 不带 `--build` 的 `up` 都不会更新代码)。

- **git clone 部署**(服务器上 `git clone` 的目录,有 `.git`):
  更新就一条 —— `./scripts/deploy.sh`(自动 `git pull` 最新 main 再重建)。

- **scp / rsync 部署**(本机拷贝上去,目录无 `.git`):代码不靠 git 进来,流程是:
  ```bash
  # 1) 本机:同步最新代码上去(务必含 prototype/showcase/ 媒体;排除 node_modules)
  rsync -avz --delete --exclude node_modules --exclude .git ./ root@<ECS_IP>:~/workspace/lingjing/
  # 2) ECS:按现有文件重建(deploy.sh 检测到无 .git 会自动跳过 git pull,等价 --no-pull)
  cd ~/workspace/lingjing && ./scripts/deploy.sh --no-pull
  ```
  > scp 漏拷 `prototype/showcase/`(~208M)会导致落地页/探索裂图;`node_modules` 不用拷(镜像内 `npm ci` 自装)。

### 部署完成后怎么校验(5 分钟过一遍)

1. **服务起来了**:`docker compose ps` 两个容器(caddy/app)都 `running`/`healthy`;`curl -s https://你的域名/healthz` 返回 `{"ok":true}`。
2. **示范素材自包含**:浏览器开 `https://你的域名/landing.html`,图全出;打开 DevTools → Network,过滤框输入 `lh-lingjing` **应为空**(素材都走 `/api/showcase-asset/...`,线上是 `302` 跳你自己的 OSS)。
3. **登录创作台**(`/login.html`):探索灵感库满屏、音色「试听」出声、参考生成影片「套用示范」素材在。
4. **积分套餐**:`/pricing.html`(登录后)显示 4 个默认套餐(¥100/500/1000/5000)。
5. **超管 + 冒烟**:`/admin/login` 用 `admin`/`SUPERADMIN_PASS` 登录 →「厂商/Key」配百炼 key → 新建租户 → 开户 → 建一条数字人视频确认成片(验证百炼 + OSS 全链路)。

> 媒体完整性自检(可选,部署机上跑):`find prototype/showcase -type f | wc -l` 应为 **107**;
> 或在仓库根跑 `bash scripts/verify-showcase.sh`(空桶起临时实例,断言五模块素材可达 + 0 外部桶 + SSRF 拦截)。

### 部署后只需配这些(其余开箱即用)

| 配在哪 | 配什么 |
|---|---|
| **`.env`(部署前)** | 超管密码 `SUPERADMIN_PASS`、主密钥 `MASTER_KEY`(`openssl rand -base64 32`)、OSS 四项、域名 |
| **`/admin`(部署后)** | 厂商 API Key:**百炼 / 火山方舟 / Google AI Studio**,在「厂商 / Key」页粘贴(加密入库) |
| **在线支付(可选)** | `.env` 填 `PUBLIC_BASE_URL`(支付回调基址,通常 `https://你的域名`)→ `/admin →「在线支付」`填微信/支付宝商户号与密钥(加密入库,保存后不回显)。不配则收银台在线通道显示「敬请期待」,对公转账不受影响。排障见 `docs/PAYMENTS-RUNBOOK.md` |

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

### Gemini(Nano Banana)走代理(中国大陆 ECS 必读)

百炼 / 火山在国内直连即可,**Google Gemini(Nano Banana 2 / Pro)在大陆 ECS 直连会被墙** → 报错「无法连接 Google Gemini(fetch failed)」。两条路:**① 不用 Gemini**(在 `/admin →「AI 图片模型」`关掉两个 gemini,主用百炼 `qwen-image/wan` + 火山 `seedream`);**② 给 Gemini 配出网代理**(下面)。

⚠️ 两个坑先知道:
- **Node 的 `fetch` 不读 `HTTP_PROXY` 环境变量**(跟 curl 不同)。所以宿主机代理 `curl --proxy` 能通、平台仍 fetch failed。平台已改为给 Gemini 这一个请求显式挂代理(`GEMINI_PROXY`),**只有 Gemini 走代理**,百炼/火山/OSS 仍直连不绕远。
- **容器里的 `127.0.0.1` ≠ 宿主机**。代理跑在宿主机,容器要用 `host.docker.internal` 才够得到。

配置三步(假设宿主机已有 clash 在 `127.0.0.1:7890`,部署见 `clash-server-proxy` 技能):

1. **让 clash 能被容器访问**:clash 配置设 `allow-lan: true`(默认只听 127.0.0.1,容器够不到),`systemctl restart clash`。
   ⚠️ allow-lan 会在公网网卡也开端口,**务必在阿里云安全组把 `7890` 和控制口 `9091` 对公网封死**(只内部用)。
2. **`.env` 配代理地址**(用 `host.docker.internal`,不是 `127.0.0.1`):
   ```
   GEMINI_PROXY=http://host.docker.internal:7890
   ```
   (只认 `GEMINI_PROXY` 这一个变量,不读通用 `HTTPS_PROXY`,避免被环境噪声误导;不填 = 直连,本地开发不受影响。)
3. **拉新代码 + 重建 + 重建容器**:`cd ~/workspace/lingjing && git pull --ff-only && ./scripts/deploy.sh`
   (重建容器吃到新 `.env`。)

> `docker-compose.yml` 已内置 `extra_hosts: host.docker.internal:host-gateway` 与 `GEMINI_PROXY` 透传,无需手改 compose。

**验证**(在容器内确认能经代理出网):
```bash
docker compose exec app node -e "const{ProxyAgent,fetch}=require('undici');fetch('https://www.gstatic.com/generate_204',{dispatcher:new ProxyAgent('http://host.docker.internal:7890')}).then(r=>console.log('OK',r.status)).catch(e=>console.log('FAIL',e.message))"
```
`OK 204` = 容器能经代理出网,去页面生成 Nano Banana 即可;`FAIL …` = 代理地址/allow-lan 没对,按生成时的报错提示排查(报错已会区分「容器内 127.0.0.1≠宿主机」等情形)。

> 备选:不想加 `extra_hosts` 可直接用 docker 网桥网关 IP,如 `GEMINI_PROXY=http://172.17.0.1:7890`(前提同样是 clash `allow-lan`);但 compose 自定义网络的网关未必是 `172.17.0.1`,故 `host.docker.internal` 更稳。

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
