#!/bin/bash
# preflight.sh — cstnew 前置健康检查
# 用法: source scripts/preflight.sh && preflight_check
# 或直接: bash scripts/preflight.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PRISMA_DIR="$PROJECT_ROOT/packages/studio-prisma"
DB_PATH="$PRISMA_DIR/prisma/data.db"
DAEMON_SCRIPT="/root/transport/events-daemon.js"
API_PORT="${API_PORT:-13101}"

ERRORS=0

echo "=== Preflight Check ==="

# 1. Prisma 迁移
echo -n "Prisma migrations... "
PENDING=$(DATABASE_URL="file:$DB_PATH" npx prisma migrate status 2>&1 | grep "not yet applied" || true)
if [ -n "$PENDING" ]; then
  echo "PENDING — applying..."
  DATABASE_URL="file:$DB_PATH" npx prisma migrate deploy 2>&1 | sed 's/^/  /'
  echo "  ✅ Migrations applied"
else
  echo "✅ up to date"
fi

# 2. events-daemon
echo -n "events-daemon... "
DAEMON_PID=$(pgrep -f "node.*events-daemon" | head -1 || true)
if [ -z "$DAEMON_PID" ]; then
  echo "NOT RUNNING — starting..."
  systemctl restart events-daemon
  sleep 2
  echo "  ✅ Started via systemd"
else
  # 检查代码是否最新（比较进程启动时间和文件修改时间）
  DAEMON_START=$(stat -c %Y /proc/$DAEMON_PID/exe 2>/dev/null || echo 0)
  DAEMON_CODE_MOD=$(stat -c %Y "$DAEMON_SCRIPT" 2>/dev/null || echo 0)
  if [ "$DAEMON_CODE_MOD" -gt "$DAEMON_START" ]; then
    echo "STALE CODE — restarting..."
    systemctl restart events-daemon
    sleep 2
    echo "  ✅ Restarted with latest code"
  else
    echo "✅ running (PID $DAEMON_PID)"
  fi
fi

# 3. Studio API（可选，cstnew 会启动）
echo -n "Studio API... "
if curl -s -o /dev/null -w '%{http_code}' "http://localhost:$API_PORT/api/v1/health" 2>/dev/null | grep -q "200"; then
  echo "✅ running"
else
  echo "⚠️ not running (cstnew will start it)"
fi

echo ""
echo "=== Preflight complete ==="
if [ $ERRORS -gt 0 ]; then
  echo "❌ $ERRORS errors found"
  exit 1
fi
