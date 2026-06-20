#!/usr/bin/env bash
# 示范媒体去中心化 —— 自验脚本。空桶(不配 OSS)起一个临时实例,逐模块断言素材可达 +
# 断言前端产物里没有残留外部桶引用。全程不碰你的真 .env / 真 OSS / 真 DB。
#   bash scripts/verify-showcase.sh
set -uo pipefail
cd "$(dirname "$0")/.."
PORT=${PORT:-9399}
DB=/tmp/lj-verify-$$.db
LOG=/tmp/lj-verify-$$.log
PASS=0; FAIL=0
ok(){ printf '  \033[32m✓\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
bad(){ printf '  \033[31m✗\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }

echo "▶ 1/4 静态产物里是否还有外部桶引用(应为 0)"
# 只匹配真实 URL(http(s)://…域名),不匹配注释里提到的词
DEMO_RESIDUE=$(grep -REl 'https?://lh-lingjing|https?://[^"'"'"' ]*tos-cn-beijing\.volces\.com|https?://[^"'"'"' ]*byteimg\.com' prototype/showcase-data.js prototype/landing.html prototype/explore.html prototype/tts.html prototype/ref-video.html prototype/avatars.html prototype/create.html 2>/dev/null | wc -l | tr -d ' ')
[ "$DEMO_RESIDUE" = "0" ] && ok "showcase-data.js + 5 模块页面:0 处外部桶" || bad "$DEMO_RESIDUE 个文件仍引用外部桶"

echo "▶ 2/4 起空桶实例(OSS 全空 → 磁盘兜底),端口 $PORT"
OSS_REGION="" OSS_BUCKET="" OSS_ACCESS_KEY_ID="" OSS_ACCESS_KEY_SECRET="" SUPERADMIN_PASS=verify123 \
  DB_FILE="$DB" PORT="$PORT" nohup npx tsx src/server.ts >"$LOG" 2>&1 &
SRV=$!
for i in $(seq 1 30); do (echo > "/dev/tcp/127.0.0.1/$PORT") >/dev/null 2>&1 && break; sleep 1; done

echo "▶ 3/4 逐模块断言素材 200(空桶 → 镜像内文件)"
check(){ # label key
  local code; code=$(curl -sS -m 25 -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/api/showcase-asset/$2")
  [ "$code" = "200" ] && ok "$1  ($2)" || bad "$1  ($2) -> $code"
}
check "落地/探索 图片" "guofeng-fly-1.jpg"
check "音色 试听"       "voices/Cherry.wav"
check "预置形象"        "avatar-preset-1.png"
check "探索 视频"       "videos/cba4edf2-cc1d-4374-aec5-e005fc00964c.mp4"
check "参考生成影片"     "ref-video/tea-pic1.jpg"
# SSRF 防护:目录穿越必须 404
SS=$(curl -sS -m 10 -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/api/showcase-asset/..%2f..%2f.env")
[ "$SS" = "404" ] && ok "SSRF 穿越被拦 (../../.env -> 404)" || bad "SSRF 未拦 -> $SS"

echo "▶ 4/4 清理"
kill "$SRV" 2>/dev/null; rm -f "$DB"* "$LOG"
echo
echo "结果: PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" = "0" ] && echo "✅ 空桶自验通过 —— 五模块素材全部从镜像/本地兜底服务,零外部依赖。" \
  || echo "❌ 有失败项,见上。"
exit "$FAIL"
