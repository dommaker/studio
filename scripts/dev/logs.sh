#!/bin/bash
# 查看开发环境日志

echo "📋 Development logs"
echo ""
echo "=== API Logs (last 50 lines) ==="
tail -50 /tmp/studio-api-dev.log 2>/dev/null || echo "No API logs"

echo ""
echo "=== Web Logs (last 30 lines) ==="
tail -30 /tmp/studio-web-dev.log 2>/dev/null || echo "No Web logs"