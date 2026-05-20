#!/bin/bash
set -e
ENV=${1:-test}
ACTION=${2:-start}
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
API_DIR="$PROJECT_ROOT/apps/api"
WEB_DIR="$PROJECT_ROOT/apps/web"
[ -f "$PROJECT_ROOT/.env" ] && source "$PROJECT_ROOT/.env"
API_PORT="${PORT:-3001}"
WEB_PORT="${VITE_PORT:-5173}"
case $ENV in
  prod|production)
    [ -f "$PROJECT_ROOT/.env.production" ] && source "$PROJECT_ROOT/.env.production"
    API_PORT="${PORT:-3001}"
    ;;
esac
echo "🔧 Environment: $ENV (API: $API_PORT, Web: $WEB_PORT)"
