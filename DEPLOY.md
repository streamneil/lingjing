# 灵镜 Docker 部署指南

把灵镜以 Docker 部署到一台 Linux 服务器(托管 SaaS 模式)。两个容器:
**Caddy**(自动 HTTPS 反代) + **app**(Node + ffmpeg)。对象存储用**阿里云 OSS**(不再用 MinIO)。

```
  Internet ─HTTPS:443─▶ Caddy ─HTTP─▶ app:9372 ─▶ SQLite(卷,本机)
                       (Let's Encrypt)            素材/成品推 阿里云 OSS(公网可达)
                                                  AI 生成调 阿里云百炼 API(算力在云端)
```

> 无外部中间件:数据库是嵌入式 SQLite,队列是 DB + 进程内 worker 池,**不需要 Redis / MySQL / MQ**。
> 一台服务器(建议 ≥4c8g、amd64)即可。AI 生成的重算力全在百炼云端,本机只做提交/轮询/拉取/ffmpeg 轻量后处理。

## 前置条件

1. **一台 Linux 服务器**,装好 Docker + Docker Compose。
2. **一个域名**,A 记录指向服务器公网 IP。
   - ⚠️ 部署前先确认解析生效:`dig +short your-domain.com` 应返回服务器 IP。
   - 解析没生效就起 Caddy,证书会反复申请失败,可能触发 Let's Encrypt 限流(同域名每周 5 次失败上限),封禁后要等一周。
3. **防火墙/安全组放行入站 80 + 443**。
   - 80 是 ACME HTTP-01 challenge 必须(只开 443 证书申不下来)。
   - app(9372)**不对外**,只 caddy 容器内反代(安全;没人能绕过 caddy 直连)。
4. **架构一致**:在服务器上 build,或 `docker build --platform linux/amd64`。
   - ⚠️ 在 Mac M 系列本地 build 出 arm64 镜像,推到 amd64 服务器会 `Exec format error`。

## 部署步骤

```bash
# 1. 拉代码
git clone <repo> && cd lingjing

# 2. 配 .env(从样板复制后填值)
cp .env.example .env
chmod 600 .env        # 限制权限,别提交 git(.gitignore 已排)
# 必填项(缺则容器拒启):
#   LJ_DOMAIN=your-domain.com
#   SUPERADMIN_PASS=<强密码>          # 超管初始密码
#   MASTER_KEY=<openssl rand -base64 32>  # 主密钥;要在 /admin 配厂商 key 必须有它
#   OSS_REGION/BUCKET/ACCESS_KEY_ID/ACCESS_KEY_SECRET  # 对象存储,四项缺一不可,见下
# COOKIE_SECURE=true(生产 HTTPS,保持默认)
# 厂商 key(百炼/火山/Google)部署后在 /admin「厂商 / Key」配,不进 .env。
#   DASHSCOPE_API_KEY 可选(仅冷启动种子百炼,留空也能起)。
# 可选:WORKER_POOL_SIZE=16(并发池;4c8g 压不住可调小到 8)

# 3. 一键部署(推荐):校验 .env → build → up → 等健康 → 打印状态
./scripts/deploy.sh
#   等价手动:docker compose up -d --build

# 4. 看日志确认起来了
docker compose logs -f app    # 看 "灵镜启动" + "初始平台超管已创建"
docker compose logs -f caddy  # 看证书申请成功(certificate obtained)
```

> 更新代码:`./scripts/deploy.sh`(自动 git pull + 重建 + 健康等待)。仅重启:`./scripts/deploy.sh --restart`。

## OSS 必须配(否则生成全失败)

wan2.2-s2v 要求素材(图片/音频)URL **公网可达**——百炼云端要能拉到你的素材。
**生产必须配阿里云 OSS**,把素材推到公网可达的桶。`OSS_REGION/BUCKET/ACCESS_KEY_ID/ACCESS_KEY_SECRET`
四项缺一不可(compose 已设为必填,缺则容器拒启)。配齐前:
- 数字人生成会卡 pending 超时(百炼拉不到素材)

OSS AccessKey 可复用 DashScope 同账号的 RAM 用户(授权 AliyunOSSFullAccess)。

## 首次使用(冷启动)

全新部署后 DB 是空的,**只有平台超管 admin,没有任何租户账号**。运营流程:

1. 浏览器开 `https://your-domain.com/admin/login`
2. 用 `admin` / `<SUPERADMIN_PASS>` 登录
3. 「新建租户」建一个机构 → 「开户」给机构建管理员账号
4. 机构用户用 `https://your-domain.com/login.html` 登录创作台

## 数据备份(SQLite)

所有租户/积分/审计数据在 `app-data` 卷的 `/data/lingjing.db`。
⚠️ **WAL 模式下别裸 `cp` 主库文件**(会漏 -wal 里未 checkpoint 的数据,得到坏备份)。

用脚本做在线一致备份(WAL 安全 + 滚动保留 14 份):

```bash
./scripts/backup.sh              # 手动备份一次,落到 ./backups/lingjing-<时间>.db
```

> 实现说明:镜像里没装 sqlite3 命令行,脚本用容器内 `node + better-sqlite3 的 .backup()`
> 做在线热备(自动合并 WAL、不锁写),再拷出宿主机。`BACKUP_DIR` / `KEEP` 可用 env 覆盖。

**定时备份**(每天 03:30,写进 crontab):

```bash
crontab -e
# 加一行(路径换成你的部署路径):
30 3 * * * cd /path/to/lingjing && ./scripts/backup.sh >> backups/backup.log 2>&1
```

**恢复**:停 app → 把某份备份拷回卷里覆盖 `lingjing.db`(删除残留 `-wal`/`-shm`)→ 重启。

## 运维

- **重启**:`docker compose restart app`。重启时卡在生成中(running)的任务会被自动标失败 + 退还预扣积分(不会留僵尸 job)。
- **更新代码**:`./scripts/deploy.sh`(自动 git pull + 重建 + 健康等待)。
- **看健康**:`docker compose ps`(app healthy 状态由 /healthz 探测)。
- **证书续期**:Caddy 自动续(证书存 caddy-data 卷,别删)。

## 私有化交付

把这份 compose + .env(域名换内网域名/自签证书)丢进客户内网即可。
注意:私有化内网下 wan2.2-s2v 的公网素材 URL 问题需单独方案(见 TODOS.md T-PUBLIC-URL)。
