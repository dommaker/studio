#!/bin/bash
# E2E 测试环境启动脚本
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
[ -f "$PROJECT_ROOT/.env" ] && source "$PROJECT_ROOT/.env"
# 一键杀残留、启动 API + Web、健康检查

set -e

API_PORT="${PORT:-3001}"
WEB_PORT="${VITE_PORT:-5173}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STUDIO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "🧹 清理残留进程..."
pkill -9 -f "tsx.*src/index" 2>/dev/null || true
pkill -9 -f "vite.*$WEB_PORT" 2>/dev/null || true
sleep 2

echo ""
echo "🚀 启动 API (PORT=$API_PORT EXECUTION_MODE=direct)..."
cd "$STUDIO_ROOT/apps/api"
PORT=$API_PORT EXECUTION_MODE=direct nohup npx tsx src/index.ts > /tmp/agent-studio-api-e2e.log 2>&1 &
API_PID=$!
echo "   API PID: $API_PID"

echo "🚀 启动 Web (VITE_PORT=$WEB_PORT VITE_DEV_API_PORT=$API_PORT)..."
cd "$STUDIO_ROOT/apps/web"
VITE_PORT=$WEB_PORT VITE_DEV_API_PORT=$API_PORT nohup npx vite --port $WEB_PORT > /tmp/agent-studio-web-e2e.log 2>&1 &
WEB_PID=$!
echo "   Web PID: $WEB_PID"

echo ""
echo "⏳ 等待服务就绪..."
for i in $(seq 1 30); do
  if ss -tlnp | grep -q ":$API_PORT" && ss -tlnp | grep -q ":$WEB_PORT"; then
    break
  fi
  sleep 1
done

echo ""
echo "🏥 健康检查..."
API_OK=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:$API_PORT/api/v1/channels 2>/dev/null || echo "000")
WEB_OK=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:$WEB_PORT/api/v1/channels 2>/dev/null || echo "000")

echo "   API :$API_PORT → $API_OK"
echo "   Web :$WEB_PORT → $WEB_OK"

if [ "$API_OK" = "200" ] && [ "$WEB_OK" = "200" ]; then
  echo ""
  echo "✅ E2E 环境就绪"
  echo ""
  echo "   运行测试: cd apps/web && npx playwright test --config=e2e/playwright.config.ts --reporter=list"
else
  echo ""
  echo "❌ 启动失败，检查日志:"
  echo "   API: tail -50 /tmp/agent-studio-api-e2e.log"
  echo "   Web: tail -50 /tmp/agent-studio-web-e2e.log"
  exit 1
fi
