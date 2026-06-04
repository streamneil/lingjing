#!/usr/bin/env bash
# 灵镜 — 本地一键起：MinIO(docker) + 应用(本地) + 种子账号。
# 应用跑本地(非容器),与种子脚本共享同一个 lingjing.db,避免容器卷不一致。
set -e
cd "$(dirname "$0")/.."

PORT=9372

echo "▶ 0/4 清理上次残留的服务(避免僵尸进程占 $PORT 跑旧代码)..."
# 杀掉占用端口的旧进程 + 上次记录的 pid + 所有 tsx server,确保起的是新代码
lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null | xargs kill 2>/dev/null || true
[ -f /tmp/lingjing-app.pid ] && kill "$(cat /tmp/lingjing-app.pid)" 2>/dev/null || true
pkill -f "tsx src/server.ts" 2>/dev/null || true
sleep 1

echo "▶ 1/4 起 MinIO(docker)..."
docker compose up -d minio >/dev/null 2>&1
sleep 4

echo "▶ 2/4 种子账号(若 DB 已存在则追加一个新机构)..."
# 必须用 tsx:种子脚本 import 的是 .ts 源码(TS 的 .js→.ts 解析,node 不支持)
DB_FILE=lingjing.db MINIO_ENDPOINT=127.0.0.1 NODE_NO_WARNINGS=1 npx tsx scripts/seed-demo.mjs

echo "▶ 3/4 启动应用(本地,连本地 MinIO)..."
echo "   日志写到 /tmp/lingjing-app.log;停止用: kill \$(cat /tmp/lingjing-app.pid)"
DB_FILE=lingjing.db MINIO_ENDPOINT=127.0.0.1 PORT=$PORT \
  nohup npx tsx src/server.ts > /tmp/lingjing-app.log 2>&1 &
echo $! > /tmp/lingjing-app.pid
sleep 3

echo "▶ 4/4 健康检查..."
curl -s http://localhost:$PORT/healthz && echo " ✓ 应用就绪"
echo ""
echo "机构后台: http://localhost:$PORT/login.html"
echo "  登录:demoadmin / pw123456(机构管理员)或 editor / pw123456(创作者)"
echo "平台超管: http://localhost:$PORT/admin/login"
echo "  登录:admin / <SUPERADMIN_PASS>(管租户、开户、充值)"
