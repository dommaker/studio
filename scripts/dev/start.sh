#!/bin/bash
# 开发环境启动脚本 - 启动 vite dev server + 后端 API

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
API_DIR="$PROJECT_ROOT/apps/api"
WEB_DIR="$PROJECT_ROOT/apps/web"

# 读取 .env（如果存在）
[ -f "$PROJECT_ROOT/.env" ] && source "$PROJECT_ROOT/.env"

API_PORT="${PORT:-3001}"
WEB_PORT="${VITE_PORT:-5173}"

echo "🚀 Starting agent-studio (development)"
echo "   API: http://localhost:$API_PORT"
echo "   Web: http://localhost:$WEB_PORT"

# 启动后端 API
cd "$API_DIR"
PORT=$API_PORT nohup npx tsx src/index.ts > /tmp/studio-api-dev.log 2>&1 &
API_PID=$!
echo "   API PID: $API_PID"

# 启动前端
cd "$WEB_DIR"
export VITE_DEV_API_PORT=$API_PORT
export VITE_PORT=$WEB_PORT
export VITE_BASE=/dev/
nohup npm run dev -- --port $WEB_PORT --host 0.0.0.0 > /tmp/studio-web-dev.log 2>&1 &
WEB_PID=$!
echo "   Web PID: $WEB_PID"

# 等待服务启动
sleep 3

# 检查服务状态
if ss -tlnp | grep -q ":$API_PORT"; then
  echo "✅ API running"
else
  echo "❌ Failed to start API"
  tail -20 /tmp/studio-api-dev.log
fi

if ss -tlnp | grep -q ":$WEB_PORT"; then
  echo "✅ Web running"
else
  echo "❌ Failed to start Web"
  tail -20 /tmp/studio-web-dev.log
fi
