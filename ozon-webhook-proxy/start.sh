#!/bin/bash
# pm2 通过 --interpreter bash 执行本脚本（见 README「部署」）。
# 每次启动重新 source env，改配置后 `pm2 restart msg` 即可，
# 不需要 --update-env。
set -a
. /root/code/ozon-webhook-proxy/ozon-webhook-proxy.env
set +a

cd /root/code/ozon-webhook-proxy || exit 1
exec ./bin/webhook-proxy 2>&1
