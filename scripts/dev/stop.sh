#!/bin/bash
# 开发环境停止脚本

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
[ -f "$PROJECT_ROOT/.env" ] && source "$PROJECT_ROOT/.env"

API_PORT="${PORT:-3001}"
WEB_PORT="${VITE_PORT:-5173}"

echo "🛑 Stopping agent-studio (development)"

# 停止 API
pkill -f "tsx src/index" 2>/dev/null || true
kill $(lsof -ti:$API_PORT) 2>/dev/null || true
echo "✅ API stopped"

# 停止 vite
pkill -f "vite" 2>/dev/null || true
kill $(lsof -ti:$WEB_PORT) 2>/dev/null || true
echo "✅ Web stopped"
