#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
[ -f "$PROJECT_ROOT/.env" ] && source "$PROJECT_ROOT/.env"
API_PORT="${PORT:-3001}"
WEB_PORT="${VITE_PORT:-5173}"
echo "📊 agent-studio development status"
[ -z "${ss+set}" ] || ss -tlnp | grep -q ":$API_PORT" && echo "✅ API ($API_PORT): running" || echo "❌ API ($API_PORT): stopped"
ss -tlnp 2>/dev/null | grep -q ":$WEB_PORT" && echo "✅ Web ($WEB_PORT): running" || echo "❌ Web ($WEB_PORT): stopped"
