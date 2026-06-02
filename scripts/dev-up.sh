#!/usr/bin/env bash
# 灵镜 — 本地一键起：MinIO(docker) + 应用(本地) + 种子账号。
# 应用跑本地(非容器),与种子脚本共享同一个 lingjing.db,避免容器卷不一致。
set -e
cd "$(dirname "$0")/.."

echo "▶ 1/4 起 MinIO(docker)..."
docker compose up -d minio >/dev/null 2>&1
sleep 4

echo "▶ 2/4 种子账号(若 DB 已存在则追加一个新机构)..."
DB_FILE=lingjing.db MINIO_ENDPOINT=127.0.0.1 node scripts/seed-demo.mjs

echo "▶ 3/4 启动应用(本地,连本地 MinIO)..."
echo "   日志写到 /tmp/lingjing-app.log;停止用: kill \$(cat /tmp/lingjing-app.pid)"
DB_FILE=lingjing.db MINIO_ENDPOINT=127.0.0.1 PORT=3000 \
  nohup npx tsx src/server.ts > /tmp/lingjing-app.log 2>&1 &
echo $! > /tmp/lingjing-app.pid
sleep 3

echo "▶ 4/4 健康检查..."
curl -s http://localhost:3000/healthz && echo " ✓ 应用就绪"
echo ""
echo "打开: http://localhost:3000/login.html"
echo "用上面种子输出的【机构 ID】+ admin / pw123456 登录"
