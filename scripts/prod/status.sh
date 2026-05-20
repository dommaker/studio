#!/bin/bash
# 生产环境状态检查

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
[ -f "$PROJECT_ROOT/.env.production" ] && source "$PROJECT_ROOT/.env.production"
API_PORT="${PORT:-3001}"

echo "📊 agent-studio production status"
echo ""

# API 状态
if ss -tlnp | grep -q ":$API_PORT"; then
  API_PID=$(ss -tlnp | grep ":$API_PORT" | grep -oP 'pid=\K\d+')
  echo "✅ API ($API_PORT): running (PID: $API_PID)"
else
  echo "❌ API ($API_PORT): stopped"
fi

# 静态文件
if [ -f "/var/www/agent-studio/index.html" ]; then
  SIZE=$(du -sh /var/www/agent-studio | cut -f1)
  echo "✅ Static files: deployed ($SIZE)"
else
  echo "⚠️  Static files: not deployed"
fi

# nginx
if pgrep nginx > /dev/null; then
  echo "✅ nginx: running"
else
  echo "❌ nginx: stopped"
fi

# 域名访问测试
echo ""
echo "🌐 Domain check:"
curl -s -I https://dommaker.cn 2>/dev/null | head -1 || echo "❌ https://dommaker.cn not accessible"