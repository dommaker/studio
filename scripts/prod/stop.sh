#!/bin/bash
# 生产环境停止脚本

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
[ -f "$PROJECT_ROOT/.env.production" ] && source "$PROJECT_ROOT/.env.production"
API_PORT="${PORT:-3001}"

echo "🛑 Stopping agent-studio (production)"

# 停止 API
if ss -tlnp | grep -q ":$API_PORT"; then
  pkill -f "tsx src/index" 2>/dev/null || true
  kill $(lsof -ti:$API_PORT) 2>/dev/null || true
  echo "✅ API stopped"
else
  echo "ℹ️  API not running"
fi

# nginx 不需要停止（由系统管理）
