#!/bin/bash
# 开发环境启动脚本 - 启动 vite dev server + 后端 API

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
API_DIR="$PROJECT_ROOT/apps/api"
WEB_DIR="$PROJECT_ROOT/apps/web"

# 读取 .env.beta（如果存在）；显式导出的环境变量优先，source 前暂存、source 后还回
EXPLICIT_PORT="${PORT-}"
EXPLICIT_VITE_PORT="${VITE_PORT-}"
[ -f "$PROJECT_ROOT/.env.beta" ] && source "$PROJECT_ROOT/.env.beta"
[ -n "$EXPLICIT_PORT" ] && PORT="$EXPLICIT_PORT"
[ -n "$EXPLICIT_VITE_PORT" ] && VITE_PORT="$EXPLICIT_VITE_PORT"

API_PORT="${PORT:-13001}"
WEB_PORT="${VITE_PORT:-13000}"

echo "🚀 Starting agent-studio (beta)"
echo "   API: http://localhost:$API_PORT"
echo "   Web: http://localhost:$WEB_PORT"

# 启动后端 API（STUDIO_HOME 隔离 dev 数据根，允许外部覆盖）
export STUDIO_HOME="${STUDIO_HOME:-$HOME/.studio-dev}"
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

# 轮询等待端口就绪（tsx 冷启动 ~5s，固定 sleep 会误报失败；#582）
wait_for_port() {
  local port=$1 pid=$2 logfile=$3 name=$4
  local deadline=$((SECONDS + 30))
  while [ $SECONDS -lt $deadline ]; do
    if ss -tlnp | grep -q ":$port "; then
      echo "✅ $name running"
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "❌ Failed to start $name (process exited)"
      tail -20 "$logfile"
      return 1
    fi
    sleep 1
  done
  echo "❌ Failed to start $name (timeout after 30s)"
  tail -20 "$logfile"
  return 1
}

# 检查服务状态
STATUS=0
wait_for_port "$API_PORT" "$API_PID" /tmp/studio-api-dev.log API || STATUS=1
wait_for_port "$WEB_PORT" "$WEB_PID" /tmp/studio-web-dev.log Web || STATUS=1
exit $STATUS
