#!/usr/bin/env bash
# 灵镜 — 本地一键起:应用(本地) + 种子账号。存储用 .env 配置的阿里云 OSS。
#
# 注:已移除 MinIO/docker 步骤 —— 本项目用阿里云 OSS(.env 配齐 OSS_REGION/BUCKET/
#     ACCESS_KEY_ID/ACCESS_KEY_SECRET 即启用,见 src/storage/index.ts)。若将来要本地
#     零配置回退到 MinIO,在 .env 留空 OSS_* 并恢复 `docker compose up -d minio`。
set -e
cd "$(dirname "$0")/.."

PORT=9372

echo "▶ 0/3 清理上次残留的服务(避免僵尸进程占 $PORT 跑旧代码)..."
# 杀掉占用端口的旧进程 + 上次记录的 pid + 所有 tsx server,确保起的是新代码
lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null | xargs kill 2>/dev/null || true
[ -f /tmp/lingjing-app.pid ] && kill "$(cat /tmp/lingjing-app.pid)" 2>/dev/null || true
pkill -f "tsx src/server.ts" 2>/dev/null || true
sleep 1

echo "▶ 1/3 种子账号(若 DB 已存在则追加一个新机构)..."
# 必须用 tsx:种子脚本 import 的是 .ts 源码(TS 的 .js→.ts 解析,node 不支持)
DB_FILE=lingjing.db NODE_NO_WARNINGS=1 npx tsx scripts/seed-demo.mjs
# 平台默认数据(积分套餐,幂等)
DB_FILE=lingjing.db NODE_NO_WARNINGS=1 npx tsx scripts/seed-platform.mjs

echo "▶ 2/3 启动应用(本地,存储连阿里云 OSS)..."
echo "   日志写到 /tmp/lingjing-app.log;停止用: kill \$(cat /tmp/lingjing-app.pid)"
DB_FILE=lingjing.db PORT=$PORT \
  nohup npx tsx src/server.ts > /tmp/lingjing-app.log 2>&1 &
echo $! > /tmp/lingjing-app.pid
sleep 3

echo "▶ 3/3 健康检查..."
curl -s http://localhost:$PORT/healthz && echo " ✓ 应用就绪"
echo ""
echo "机构后台: http://localhost:$PORT/login.html"
echo "  登录:demoadmin / pw123456(机构管理员)或 editor / pw123456(创作者)"
echo "平台超管: http://localhost:$PORT/admin/login"
echo "  登录:admin / <SUPERADMIN_PASS>(管租户、开户、充值)"
