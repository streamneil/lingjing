#!/usr/bin/env bash
# 灵镜 — 本地一键起:应用(本地)+ 种子 demo 账号。新克隆开箱即用。
#
# 零 OSS 也能跑:没配 OSS_*(.env 留空)时,存储回退本机,且**示范素材(落地页/探索灵感/
# 音色试听/预置形象/参考生成影片)走端点 /api/showcase-asset 的本地磁盘兜底**(媒体随仓在
# prototype/showcase/),开箱即完整显示。只有"真实生成"(数字人视频等)才需要 OSS + 厂商 key
# (百炼要公网可达素材 URL),没配时生成会卡 pending,但 UI/试听/灵感库照常。
#
# 默认积分套餐由 app 启动时自动种子(src/server.ts,表空才灌、幂等),本脚本无需单独灌。
set -euo pipefail
cd "$(dirname "$0")/.."

# 端口:优先 .env 的 PORT,缺省 9372。
PORT=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2- | tr -d '[:space:]' || true)
PORT=${PORT:-9372}

# 运行态产物放工作区本地(避免多用户机 /tmp 撞文件/权限;已 .gitignore)。
RUN_DIR="./.run"
PID_FILE="$RUN_DIR/lingjing-app.pid"
LOG_FILE="$RUN_DIR/lingjing-app.log"
mkdir -p "$RUN_DIR"

echo "▶ 0/3 清理上次残留的服务(避免僵尸进程占 $PORT 跑旧代码)..."
# 杀掉占用端口的旧进程(无进程时不调 kill,免 macOS xargs 空参告警)+ 上次 pid + 所有 tsx server
PIDS=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true)
[ -n "$PIDS" ] && kill $PIDS 2>/dev/null || true
[ -f "$PID_FILE" ] && kill "$(cat "$PID_FILE")" 2>/dev/null || true
pkill -f "tsx src/server.ts" 2>/dev/null || true
sleep 1

echo "▶ 1/3 种子 demo 账号(若 DB 已存在则追加一个新机构;积分套餐由启动自动灌)..."
# 必须用 tsx:种子脚本 import 的是 .ts 源码(node 不支持 TS 的 .js→.ts 解析)
DB_FILE=lingjing.db NODE_NO_WARNINGS=1 npx tsx scripts/seed-demo.mjs

echo "▶ 2/3 启动应用(本地;OSS 配了走 OSS,没配走本机 + 磁盘兜底)..."
echo "   日志:$LOG_FILE;停止:kill \$(cat $PID_FILE)"
DB_FILE=lingjing.db PORT="$PORT" \
  nohup npx tsx src/server.ts > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
sleep 3

echo "▶ 3/3 健康检查..."
curl -s "http://localhost:$PORT/healthz" && echo " ✓ 应用就绪" || echo " ⚠ 健康检查未通过,看日志:tail -f $LOG_FILE"
echo ""
echo "机构后台: http://localhost:$PORT/login.html"
echo "  登录:demoadmin / pw123456(机构管理员)或 editor / pw123456(创作者)"
echo "平台超管: http://localhost:$PORT/admin/login"
echo "  登录:admin / <SUPERADMIN_PASS>(管租户、开户、充值)"
echo "提示:没配 OSS 也能看落地页/探索/试听/购买套餐;真实生成需 /admin 配厂商 key(+ OSS)。"
