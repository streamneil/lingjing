#!/usr/bin/env bash
# 灵镜 一键部署 / 更新脚本。
# 在服务器上(已装 Docker + Compose、已配好 .env)跑这个即可完成部署或更新。
#
#   首次部署: ./scripts/deploy.sh
#   更新代码: ./scripts/deploy.sh            (会 git pull 后重建)
#   只重启不拉代码/不重建: ./scripts/deploy.sh --restart
#
# 它会:校验前置 → (可选)git pull → docker compose build & up → 等 app 健康 → 打印状态。
# 任何一步失败即退出(set -e),不会留半拉子状态。

set -euo pipefail
cd "$(dirname "$0")/.."   # 切到仓库根

RESTART_ONLY=false
NO_PULL=false
for arg in "$@"; do
  case "$arg" in
    --restart) RESTART_ONLY=true ;;
    --no-pull) NO_PULL=true ;;
    -h|--help) echo "用法: $0 [--restart] [--no-pull]"; exit 0 ;;
    *) echo "未知参数: $arg"; exit 1 ;;
  esac
done

log(){ printf '\033[1;36m[deploy]\033[0m %s\n' "$*"; }
die(){ printf '\033[1;31m[deploy] ✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── 0. 前置校验 ──
command -v docker >/dev/null || die "未装 docker"
docker compose version >/dev/null 2>&1 || die "未装 docker compose(v2)"
[ -f .env ] || die "缺 .env(从 .env.example 复制后填值:cp .env.example .env)"
chmod 600 .env 2>/dev/null || true

# .env 必填项检查(缺则 compose 会在 up 时报错,这里提前拦,信息更友好)
# 注:厂商 key(百炼/火山/Google)在 /admin 配,不在此列;MASTER_KEY 必填——它是后台贴 key 的前提。
need_env(){ grep -qE "^$1=.+" .env || die ".env 缺少 $1(或值为空)"; }
for k in LJ_DOMAIN SUPERADMIN_PASS MASTER_KEY OSS_REGION OSS_BUCKET OSS_ACCESS_KEY_ID OSS_ACCESS_KEY_SECRET; do
  need_env "$k"
done
# 提醒:厂商 API Key(百炼/火山/Google)部署后在 /admin →「厂商 / Key」配,不写进 .env。
log "ℹ 部署后到 /admin →「厂商 / Key」粘贴百炼/火山/Google 的 API Key(需已配 MASTER_KEY)。"

# 架构提醒:Mac M 系列本地 build 出 arm64,推 amd64 服务器会 Exec format error。
# 本脚本默认在服务器本机 build,架构天然一致;这里只在检测到非 amd64 主机时提示。
ARCH="$(uname -m)"
[ "$ARCH" = "x86_64" ] || [ "$ARCH" = "amd64" ] || \
  log "⚠ 当前主机架构是 $ARCH(非 amd64)。若目标服务器是 amd64,请在服务器上跑本脚本,别推本地镜像。"

if [ "$RESTART_ONLY" = true ]; then
  log "仅重启 app(不拉代码、不重建)…"
  docker compose restart app
else
  # ── 1. 拉最新代码(在 git 仓库且非 --no-pull 时)──
  if [ "$NO_PULL" = false ] && [ -d .git ]; then
    log "git pull(分支 $(git rev-parse --abbrev-ref HEAD))…"
    git pull --ff-only || die "git pull 失败(本地有改动?手动处理后重试,或加 --no-pull)"
  fi
  # ── 2. 构建 + 启动(--build 强制按最新代码重建镜像)──
  log "docker compose up -d --build …"
  docker compose up -d --build
fi

# ── 3. 等 app 健康(最多 ~90s)──
log "等待 app 健康检查通过…"
for i in $(seq 1 18); do
  state="$(docker compose ps --format '{{.Name}} {{.Health}}' 2>/dev/null | awk '/app/{print $2}' | head -1)"
  if [ "$state" = "healthy" ]; then log "✓ app healthy"; break; fi
  if [ "$i" = "18" ]; then
    log "✗ app 90s 内未 healthy,打印近期日志:"; docker compose logs --tail 40 app
    die "部署后 app 未通过健康检查,请查上面日志"
  fi
  sleep 5
done

# ── 4. 状态汇总 ──
log "当前服务状态:"
docker compose ps
log "完成。访问 https://$(grep -E '^LJ_DOMAIN=' .env | cut -d= -f2-)/admin/login 用超管登录。"
log "(看日志:docker compose logs -f app)"
