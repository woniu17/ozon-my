#!/usr/bin/env bash
# 采购信息跨机同步 · 每日备份脚本(2026-10-13)
#
# 功能:
#   1) 调用 scripts/export-purchase-sync.mjs 全量导出"带人工操作痕迹"的订单数据
#      (有采购关联/有称重/已交运/已搁置的包裹),输出 JSON 到备份目录
#   2) 备份目录 /data/ozonerp,保留最近 7 天备份,自动清理更早文件
#   3) rsync 将 /data/ozonerp 镜像同步到 2.tencent.yochylin.com 服务器同目录
#
# 用法:
#   bash scripts/backup-purchase-sync.sh                    # 手动执行
#   示例 crontab(每天 02:30):
#     30 2 * * * /bin/bash /root/code/ozon-my/erp-backend-lite/scripts/backup-purchase-sync.sh >> /data/ozonerp/backup.log 2>&1
#
# 可覆盖的环境变量:
#   APP_DIR       ERP 后端目录(默认 /root/code/ozon-my/erp-backend-lite)
#   BACKUP_DIR    本地备份目录(默认 /data/ozonerp)
#   REMOTE_HOST   远端服务器(默认 root@2.tencent.yochylin.com)
#   REMOTE_DIR    远端备份目录(默认同 BACKUP_DIR)
#   KEEP_DAYS     保留天数(默认 7)
#   LOG_FILE      运行日志(默认 $BACKUP_DIR/backup.log)
set -euo pipefail

APP_DIR="${APP_DIR:-/root/code/ozon-my/erp-backend-lite}"
BACKUP_DIR="${BACKUP_DIR:-/data/ozonerp}"
REMOTE_HOST="${REMOTE_HOST:-root@2.tencent.yochylin.com}"
REMOTE_DIR="${REMOTE_DIR:-$BACKUP_DIR}"
KEEP_DAYS="${KEEP_DAYS:-7}"
LOG_FILE="${LOG_FILE:-$BACKUP_DIR/backup.log}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] $*" | tee -a "$LOG_FILE"; }

mkdir -p "$BACKUP_DIR"
cd "$APP_DIR"

log "==== 采购信息备份开始 (dir=$BACKUP_DIR, keep=${KEEP_DAYS}天, remote=${REMOTE_HOST}:${REMOTE_DIR}) ===="

# 1) 导出(UTC 时间戳,与导出脚本默认命名一致)
TS="$(date -u +%Y%m%d%H%M%S)"
OUT="$BACKUP_DIR/purchase-sync-export-$TS.json"
node scripts/export-purchase-sync.mjs --out "$OUT" | tee -a "$LOG_FILE"

# 2) 清理超过保留天数的备份
log "清理 ${KEEP_DAYS} 天前的备份:"
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'purchase-sync-export-*.json' -mtime +"$KEEP_DAYS" -print -delete | tee -a "$LOG_FILE"

# 3) 同步到远端服务器(镜像模式:本地删除的旧备份在远端同步删除)
log "rsync 同步到 ${REMOTE_HOST}:${REMOTE_DIR}"
rsync -avz --delete "$BACKUP_DIR/" "${REMOTE_HOST}:${REMOTE_DIR}/" | tee -a "$LOG_FILE"

log "==== 采购信息备份完成 (文件: $(basename "$OUT")) ===="