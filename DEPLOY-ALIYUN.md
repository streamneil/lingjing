# 灵镜 · 阿里云 ECS 部署 Checklist

一份从零到上线的实战清单。架构:**Caddy(HTTPS) + app** 两个 Docker 容器 + 阿里云 OSS。
无 Redis / MySQL / MQ,数据库是嵌入式 SQLite。AI 算力全在阿里云百炼云端,本机只做编排。

---

## 0. 服务器要求(够用就行)

| 项 | 建议 | 说明 |
|---|---|---|
| 实例规格 | **4c8g 起步**（够用,偏宽裕） | 重算力在百炼云端;本机吃 CPU 的只有 ffmpeg(视频拼接/打 AI 标识)和 SQLite |
| 架构 | **x86_64 / amd64** | 镜像在本机 build,架构天然一致;别用 Mac M 系列本地 build 出 arm64 推上来(`Exec format error`) |
| 系统盘 | 40G+ SSD | SQLite 库 + Docker 镜像 + 临时素材;成品/素材都推 OSS 不占本盘 |
| 操作系统 | Ubuntu 22.04 / Alibaba Cloud Linux 3 | 任意主流 Linux 均可 |
| 带宽 | 5Mbps+ 按量/固定 | 主要是拉百炼成品 + 推 OSS,瞬时不大 |
| 地域 | **与 OSS 桶同地域**（如都在杭州) | 同地域内网传输免流量费、更快 |

> 并发:`WORKER_POOL_SIZE` 默认 16(最多同时处理 16 个生成任务)。4c8g 上若 ffmpeg 高峰卡顿,
> 在 `.env` 调小到 8;量大了再升服务器规格,不必改架构。

---

## 1. 阿里云控制台准备(部署前)

- [ ] **ECS 实例**已创建(4c8g、amd64、上述系统),拿到**公网 IP**。
- [ ] **安全组**入方向放行:**80**(ACME 证书校验必须)、**443**(HTTPS)、**22**(SSH 管理)。
      ⚠️ 不要放行 9372(app 只走 caddy 反代,不对外)。
- [ ] **域名**已备案(中国大陆服务器强制),并把 **A 记录**指向 ECS 公网 IP。
      验证:`dig +short your-domain.com` 返回该 IP 才继续(否则 Caddy 申证书会反复失败、触发 Let's Encrypt 限流)。
- [ ] **厂商 key 备好**(部署后在 /admin 配,不进 .env):百炼(DashScope)必备;火山方舟 / Google AI Studio 按需。
- [ ] **生成 `MASTER_KEY`**:`openssl rand -base64 32`(用来加密入库的厂商 key,必填)。
- [ ] **OSS 桶**已创建(与 ECS 同地域),记下 `region`(如 `oss-cn-hangzhou`)和 `bucket` 名。
      桶**读权限设为公共读**(或确保百炼能拉到素材 URL);写仍走 AccessKey。
- [ ] **RAM 用户 + AccessKey**:授权 `AliyunOSSFullAccess`(可复用 DashScope 同账号 RAM 用户)。
      拿到 `OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET`。

---

## 2. 服务器装环境(SSH 登进 ECS 后)

```bash
# 装 Docker + Compose 插件(Ubuntu/Debian)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker   # 免 sudo 跑 docker(重连生效)
docker version && docker compose version          # 确认都 ok
```

> Alibaba Cloud Linux 可用 `sudo yum install -y docker-ce docker-compose-plugin` 或同样的 get.docker.com 脚本。

---

## 3. 拉代码 + 配 .env

```bash
git clone https://github.com/streamneil/lingjing.git && cd lingjing
cp .env.example .env && chmod 600 .env
vi .env     # 填下面这些(缺任一必填项,容器会拒启)
```

`.env` **必填**:

```ini
LJ_DOMAIN=your-domain.com                  # 已解析到本机的域名
LJ_ACME_EMAIL=you@example.com              # 证书到期通知(建议填)
SUPERADMIN_PASS=<一个强密码>                # 平台超管初始密码
MASTER_KEY=<openssl rand -base64 32>       # 主密钥;要在 /admin 配厂商 key 必须有它
OSS_REGION=oss-cn-hangzhou                  # 纯 region 名,别填完整 URL
OSS_BUCKET=<你的桶名>
OSS_ACCESS_KEY_ID=<RAM AccessKeyId>
OSS_ACCESS_KEY_SECRET=<RAM AccessKeySecret>
# 可选
WORKER_POOL_SIZE=16                         # 4c8g 压不住可调 8
COOKIE_SECURE=true                          # 生产保持 true
TZ=Asia/Shanghai
```

> **厂商 API Key 在哪配**:百炼 / 火山方舟 / Google AI Studio 三家 key,部署后在
> **`/admin →「厂商 / Key」**粘贴(加密入库)。`.env` 里厂商 key 都可不填——但 `MASTER_KEY`
> 必须配,否则后台贴 key 会失败。

---

## 4. 一键部署

```bash
./scripts/deploy.sh
```

脚本会:校验 .env 必填项 → `docker compose up -d --build` → 等 app 健康 → 打印状态。
然后看日志确认:

```bash
docker compose logs -f app     # 看 "灵镜启动" + "初始平台超管已创建"
docker compose logs -f caddy   # 看 "certificate obtained"(证书申下来了)
```

---

## 5. 冷启动(首次运营)

全新部署 DB 是空的,只有平台超管:

1. 浏览器开 `https://your-domain.com/admin/login`
2. `admin` / `<SUPERADMIN_PASS>` 登录
3. 「新建租户」建机构 → 「开户」给机构建管理员账号
4. 机构用户用 `https://your-domain.com/login.html` 登录创作台
5. **冒烟测试**:建一条数字人视频,确认能成片(验证百炼 + OSS 全链路通)。

---

## 6. 上线后必做

- [ ] **配置定时备份**(每天 03:30):
  ```bash
  crontab -e
  # 加(路径换成实际):
  30 3 * * * cd /home/你的用户/lingjing && ./scripts/backup.sh >> backups/backup.log 2>&1
  ```
- [ ] **首次手动备份**验证脚本能跑:`./scripts/backup.sh`(应在 `./backups/` 生成 .db)。
- [ ] **确认证书自动续期**:Caddy 自动续,证书存 `caddy-data` 卷,别删卷。
- [ ] **OSS 生命周期**(可选):给临时素材前缀设过期规则,省存储费。

---

## 7. 日常运维速查

| 操作 | 命令 |
|---|---|
| 更新代码上线 | `./scripts/deploy.sh` |
| 只重启 app | `./scripts/deploy.sh --restart` |
| 看健康状态 | `docker compose ps` |
| 看日志 | `docker compose logs -f app` |
| 手动备份 | `./scripts/backup.sh` |
| 恢复备份 | 停 app → 备份覆盖卷内 `lingjing.db`(删 `-wal`/`-shm`)→ 重启 |

---

## 常见坑

- **证书申不下来**:多半是 80 没放行 / 域名没解析到本机 / 解析没生效就启了 Caddy(触发限流,等一周或换域名)。
- **数字人生成卡 pending**:OSS 四项没配齐,或桶不可公共读 → 百炼拉不到素材。
- **`Exec format error`**:在 arm64(Mac M)build 了镜像推到 amd64 服务器。请在服务器本机 build。
- **改了 .env 不生效**:`docker compose up -d`(或 `./scripts/deploy.sh`)重建,`restart` 不重读全部 env。
