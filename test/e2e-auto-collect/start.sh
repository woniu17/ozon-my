#!/usr/bin/env bash
# 端到端测试一键启动脚本
#
# 启动顺序:
#   1. mock-server (端口 7777,模拟 www.ozon.ru + seller.ozon.ru)
#   2. erp-backend-lite (端口 3001,提供 store-classification 接口)
#   3. puppeteer-runner (执行测试场景)
#
# 用法:
#   ./start.sh                # 全场景运行
#   ./start.sh basic          # 仅运行 basic 场景
#   ./start.sh antibot        # 运行反爬场景(自动以 MOCK_ANTIBOT=1 启动 mock)
#
# 前置条件:
#   - Node.js >= 22.5.0
#   - 已在 test/e2e-auto-collect 执行 npm install
#   - 已在 erp-backend-lite 执行 npm install
#   - MongoDB 服务可访问(配置在 erp-backend-lite/.env)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MOCK_DIR="$SCRIPT_DIR/mock-server"
RUNNER_DIR="$SCRIPT_DIR/runner"
ERP_DIR="$REPO_ROOT/erp-backend-lite"

SCENARIO="${1:-all}"
IS_ANTIBOT=0
if [[ "$SCENARIO" == "antibot" ]]; then
  IS_ANTIBOT=1
fi

echo "[start] 仓库根: $REPO_ROOT"
echo "[start] 场景: $SCENARIO  反爬模式: $IS_ANTIBOT"

# 清理函数:退出时杀掉后台进程
cleanup() {
  echo "[start] 清理后台进程..."
  [[ -n "${MOCK_PID:-}" ]] && kill "$MOCK_PID" 2>/dev/null || true
  [[ -n "${ERP_PID:-}" ]] && kill "$ERP_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# 1. 启动 mock-server
echo "[start] 启动 mock-server (端口 7777)..."
if [[ "$IS_ANTIBOT" == "1" ]]; then
  MOCK_ANTIBOT=1 node "$MOCK_DIR/server.js" &
else
  node "$MOCK_DIR/server.js" &
fi
MOCK_PID=$!
sleep 2

# 验证 mock-server 已就绪
if ! curl -s -o /dev/null -w "%{http_code}" http://localhost:7777/ | grep -q "200"; then
  echo "[start] 错误:mock-server 启动失败"
  exit 1
fi
echo "[start] mock-server 已就绪 (PID=$MOCK_PID)"

# 2. 启动 erp-backend-lite
echo "[start] 启动 erp-backend-lite (端口 3001)..."
(cd "$ERP_DIR" && npm run start) &
ERP_PID=$!
sleep 5

# 验证 erp-backend-lite 已就绪
for i in 1 2 3 4 5; do
  if curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/health 2>/dev/null | grep -q "200"; then
    echo "[start] erp-backend-lite 已就绪 (PID=$ERP_PID)"
    break
  fi
  echo "[start] 等待 erp-backend-lite 启动 ($i/5)..."
  sleep 3
done

# 3. 运行 puppeteer-runner
echo "[start] 运行 puppeteer-runner 场景: $SCENARIO"
node "$RUNNER_DIR/puppeteer-runner.js" "$SCENARIO"

echo "[start] 测试完成"
