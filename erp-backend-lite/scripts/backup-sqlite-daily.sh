#!/usr/bin/env bash
# SQLite 数据库每日一致性快照备份(2026-10-13)
#
# 功能:
#   1) 调用 scripts/backup-sqlite.mjs 对 erp.db / collect.db 做一致性快照
#      (VACUUM INTO,WAL 模式下也安全)
#   2) gzip 压缩快照(实测压缩率约 83%,erp ~1.1G / collect ~0.9G),压缩后删除原快照
#   3) 保留最近 7 天快照,自动清理更早文件
#   4) rsync 将 /data/ozonerp(含快照与采购导出)镜像同步到腾讯云
#
# 用法:
#   bash scripts/backup-sqlite-daily.sh                    # 手动执行
#   示例 crontab(每天 03:30):
#     30 3 * * * /bin/bash /root/code/ozon-my/erp-backend-lite/scripts/backup-sqlite-daily.sh >> /data/ozonerp/backup.log 2>&1
#
# 可覆盖的环境变量:
#   APP_DIR       ERP 后端目录(默认 /root/code/ozon-my/erp-backend-lite)
#   DATA_DIR      SQLite 数据目录(默认 $APP_DIR/data)
#   BACKUP_DIR    本地备份目录(默认 /data/ozonerp)
#   REMOTE_HOST   远端服务器(默认 root@2.tencent.yochylin.com)
#   REMOTE_DIR    远端备份目录(默认同 BACKUP_DIR)
#   KEEP_DAYS     保留天数(默认 7)
#   LOG_FILE      运行日志(默认 $BACKUP_DIR/backup.log)
set -euo pipefail

APP_DIR="${APP_DIR:-/root/code/ozon-my/erp-backend-lite}"
DATA_DIR="${DATA_DIR:-$APP_DIR/data}"
BACKUP_DIR="${BACKUP_DIR:-/data/ozonerp}"
DB_BACKUP_DIR="$BACKUP_DIR/db"
REMOTE_HOST="${REMOTE_HOST:-root@2.tencent.yochylin.com}"
REMOTE_DIR="${REMOTE_DIR:-$BACKUP_DIR}"
KEEP_DAYS="${KEEP_DAYS:-7}"
LOG_FILE="${LOG_FILE:-$BACKUP_DIR/backup.log}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] $*" | tee -a "$LOG_FILE"; }

mkdir -p "$BACKUP_DIR" "$DB_BACKUP_DIR"
cd "$APP_DIR"

log "==== 数据库每日快照备份开始 (dir=$DB_BACKUP_DIR, keep=${KEEP_DAYS}天, remote=${REMOTE_HOST}:${REMOTE_DIR}) ===="

TS="$(TZ=Asia/Shanghai date +%Y%m%d%H%M%S)"

# 1) 一致性快照(VACUUM INTO)
node scripts/backup-sqlite.mjs "$DATA_DIR/erp.db" "$DB_BACKUP_DIR/erp-$TS.db" | tee -a "$LOG_FILE"
if [ -f "$DATA_DIR/collect.db" ]; then
  node scripts/backup-sqlite.mjs "$DATA_DIR/collect.db" "$DB_BACKUP_DIR/collect-$TS.db" | tee -a "$LOG_FILE"
else
  log "collect.db 不存在,跳过采集库备份"
fi

# 2) gzip 压缩(压缩后删除原快照文件)
log "gzip 压缩快照..."
if [ -f "$DB_BACKUP_DIR/erp-$TS.db" ]; then
  gzip -f "$DB_BACKUP_DIR/erp-$TS.db"
fi
if [ -f "$DB_BACKUP_DIR/collect-$TS.db" ]; then
  gzip -f "$DB_BACKUP_DIR/collect-$TS.db"
fi
log "压缩完成: erp-$TS.db.gz / collect-$TS.db.gz"

# 3) 清理超过保留天数的快照
log "清理 ${KEEP_DAYS} 天前的快照:"
find "$DB_BACKUP_DIR" -maxdepth 1 -type f -name '*.db.gz' -mtime +"$KEEP_DAYS" -print -delete | tee -a "$LOG_FILE"

# 4) 同步到远端服务器(镜像模式:本地删除的旧备份在远端同步删除)
log "rsync 同步到 ${REMOTE_HOST}:${REMOTE_DIR}"
rsync -avz --delete "$BACKUP_DIR/" "${REMOTE_HOST}:${REMOTE_DIR}/" | tee -a "$LOG_FILE"

log "==== 数据库每日快照备份完成 (erp-$TS.db.gz / collect-$TS.db.gz) ===="