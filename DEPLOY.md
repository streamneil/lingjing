# 灵镜 Docker 部署指南

把灵镜以 Docker 部署到一台 Linux 服务器(托管 SaaS 模式)。三个容器:
**Caddy**(自动 HTTPS 反代) + **app**(Node + ffmpeg) + **MinIO**(对象存储占位)。

```
  Internet ─HTTPS:443─▶ Caddy ─HTTP─▶ app:9372 ─▶ SQLite(卷) + MinIO(内网)
                       (Let's Encrypt)            生成时素材推 OSS(公网可达)
```

## 前置条件

1. **一台 Linux 服务器**,装好 Docker + Docker Compose。
2. **一个域名**,A 记录指向服务器公网 IP。
   - ⚠️ 部署前先确认解析生效:`dig +short your-domain.com` 应返回服务器 IP。
   - 解析没生效就起 Caddy,证书会反复申请失败,可能触发 Let's Encrypt 限流(同域名每周 5 次失败上限),封禁后要等一周。
3. **防火墙/安全组放行入站 80 + 443**。
   - 80 是 ACME HTTP-01 challenge 必须(只开 443 证书申不下来)。
   - app(9372)、MinIO(9000/9001)**不对外**,只容器间互访(安全)。
4. **架构一致**:在服务器上 build,或 `docker build --platform linux/amd64`。
   - ⚠️ 在 Mac M 系列本地 build 出 arm64 镜像,推到 amd64 服务器会 `Exec format error`。

## 部署步骤

```bash
# 1. 拉代码
git clone <repo> && cd digital-human

# 2. 配 .env(从样板复制后填值)
cp .env.example .env
chmod 600 .env        # 限制权限,别提交 git(.gitignore 已排)
# 必填项(缺则容器拒启):
#   LJ_DOMAIN=your-domain.com
#   SUPERADMIN_PASS=<强密码>          # 超管初始密码
#   MINIO_ACCESS_KEY / MINIO_SECRET_KEY  # 别用默认 minioadmin
#   DASHSCOPE_API_KEY                   # 百炼 API key
#   OSS_REGION/BUCKET/ACCESS_KEY_ID/ACCESS_KEY_SECRET  # 生成视频需公网素材,见下
# COOKIE_SECURE=true(生产 HTTPS,保持默认)

# 3. 起服务
docker compose up -d --build

# 4. 看日志确认起来了
docker compose logs -f app    # 看 "灵镜启动" + "初始平台超管已创建"
docker compose logs -f caddy  # 看证书申请成功(certificate obtained)
```

## OSS 必须配(否则生成全失败)

wan2.2-s2v 要求素材(图片/音频)URL **公网可达**。容器内 MinIO 是内网,百炼云端访问不到。
**生产必须配 OSS**(阿里云对象存储),把素材推到公网可达的桶。OSS 没配齐时:
- app 启动会打 `[警告] OSS 未配齐` 日志
- 数字人生成会卡 pending 超时

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
用 SQLite 在线一致备份:

```bash
docker compose exec app sqlite3 /data/lingjing.db ".backup /data/backup-$(date +%F).db"
docker compose cp app:/data/backup-2026-06-05.db ./backup-2026-06-05.db
```

(自动定时备份未做,见 TODO。)

## 运维

- **重启**:`docker compose restart app`。重启时卡在生成中(running)的任务会被自动标失败 + 退还预扣积分(不会留僵尸 job)。
- **更新代码**:`git pull && docker compose up -d --build`。
- **看健康**:`docker compose ps`(app healthy 状态由 /healthz 探测)。
- **证书续期**:Caddy 自动续(证书存 caddy-data 卷,别删)。

## 私有化交付

把这份 compose + .env(域名换内网域名/自签证书)丢进客户内网即可。
注意:私有化内网下 wan2.2-s2v 的公网素材 URL 问题需单独方案(见 TODOS.md T-PUBLIC-URL)。
