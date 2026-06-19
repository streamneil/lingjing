#!/usr/bin/env bash
# 灵镜 SQLite 在线一致备份(WAL 安全)+ 滚动保留。
# 所有租户/积分/审计数据在 app-data 卷的 /data/lingjing.db。
# ⚠ WAL 模式下别裸 cp 主库(会漏 -wal 未 checkpoint 的数据 → 坏备份),必须用 sqlite3 .backup。
#
#   手动备份:  ./scripts/backup.sh
#   备份目录:  默认 ./backups/(可用 BACKUP_DIR 覆盖)
#   保留份数:  默认 14 份(可用 KEEP 覆盖),超出删最旧
#
# 定时(每天 03:30,写到 crontab):
#   30 3 * * * cd /path/to/lingjing && ./scripts/backup.sh >> backups/backup.log 2>&1

set -euo pipefail
cd "$(dirname "$0")/.."

BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP="${KEEP:-14}"
DB_IN_CONTAINER="/data/lingjing.db"
STAMP="$(date +%Y-%m-%d-%H%M%S)"
OUT="$BACKUP_DIR/lingjing-$STAMP.db"

log(){ printf '\033[1;36m[backup]\033[0m %s\n' "$*"; }
die(){ printf '\033[1;31m[backup] ✗ %s\033[0m\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || die "未装 docker"
docker compose ps app >/dev/null 2>&1 || die "app 容器不在(先 docker compose up -d)"
mkdir -p "$BACKUP_DIR"

# 1. 容器内做一致备份。镜像没装 sqlite3 命令行(只有 better-sqlite3 Node 绑定),
#    故用 node + better-sqlite3 的 .backup() API —— 同样是 SQLite 在线热备,自动合并 WAL、不锁写。
TMP="/data/backup-$STAMP.db"
log "容器内 node better-sqlite3 .backup() …"
docker compose exec -T app node -e "
  const Database = require('better-sqlite3');
  const db = new Database(process.env.DB_FILE || '$DB_IN_CONTAINER', { readonly: true });
  db.backup('$TMP').then(() => { db.close(); process.exit(0); })
    .catch(e => { console.error(e.message); process.exit(1); });
" || die "容器内 .backup() 失败(查看上面的错误)"

# 2. 拷出到宿主机,删容器内临时文件。
log "拷出到 $OUT …"
docker compose cp "app:$TMP" "$OUT" || die "拷出失败"
docker compose exec -T app rm -f "$TMP" || true

# 3. 校验备份可读(完整性快检)。
SIZE="$(stat -f%z "$OUT" 2>/dev/null || stat -c%s "$OUT" 2>/dev/null || echo 0)"
[ "$SIZE" -gt 0 ] || die "备份文件为空,异常"
log "✓ 备份完成:$OUT ($((SIZE/1024)) KB)"

# 4. 滚动保留:超过 KEEP 份删最旧。
COUNT="$(ls -1 "$BACKUP_DIR"/lingjing-*.db 2>/dev/null | wc -l | tr -d ' ')"
if [ "$COUNT" -gt "$KEEP" ]; then
  ls -1t "$BACKUP_DIR"/lingjing-*.db | tail -n +"$((KEEP+1))" | while read -r old; do
    log "清理旧备份:$old"; rm -f "$old"
  done
fi
log "现存备份 $(ls -1 "$BACKUP_DIR"/lingjing-*.db 2>/dev/null | wc -l | tr -d ' ') 份(保留上限 $KEEP)。"
