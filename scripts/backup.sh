#!/usr/bin/env bash
# OpenCS 数据备份：对 OPENCS_DATA_DIR 下所有 SQLite 做一致性快照（.backup），
# 连同 sessions/ 会话日志打包 tar.gz，按份数轮转。
#
# 用法：
#   bash scripts/backup.sh                          # ./data -> ./backups，保留 14 份
#   OPENCS_DATA_DIR=/srv/opencs/data \
#   OPENCS_BACKUP_DIR=/srv/opencs/backups \
#   OPENCS_BACKUP_KEEP=30 bash scripts/backup.sh    # Docker 部署：在宿主机对 /data 卷执行
set -euo pipefail

DATA_DIR="${OPENCS_DATA_DIR:-./data}"
BACKUP_DIR="${OPENCS_BACKUP_DIR:-./backups}"
KEEP="${OPENCS_BACKUP_KEEP:-14}"

if [ ! -d "$DATA_DIR" ]; then
  echo "数据目录不存在：$DATA_DIR" >&2
  exit 1
fi

stamp="$(date +%Y%m%d-%H%M%S)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$BACKUP_DIR"

for db in "$DATA_DIR"/*.db; do
  [ -e "$db" ] || continue
  if command -v sqlite3 >/dev/null 2>&1; then
    # WAL 模式下唯一安全的在线备份方式
    sqlite3 "$db" ".backup '$work/$(basename "$db")'"
  else
    echo "警告：未找到 sqlite3，退化为直接拷贝（服务写入中可能得到不一致快照）" >&2
    cp "$db" "$work/"
  fi
done

[ -d "$DATA_DIR/sessions" ] && cp -R "$DATA_DIR/sessions" "$work/sessions"

archive="$BACKUP_DIR/opencs-$stamp.tar.gz"
tar -czf "$archive" -C "$work" .

# 轮转：只保留最近 KEEP 份
ls -1t "$BACKUP_DIR"/opencs-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f "$old"
done

echo "backup -> $archive ($(du -h "$archive" | cut -f1))"
