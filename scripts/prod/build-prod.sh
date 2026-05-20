#!/bin/bash
# 打包线上前端静态文件

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WEB_DIR="$PROJECT_ROOT/apps/web"
DEPLOY_DIR="/var/www/agent-studio"

echo "📦 Building agent-studio frontend..."

cd "$WEB_DIR"

# 打包
npm run build

# 确认输出
if [ -f "dist/index.html" ]; then
  echo "✅ Build successful"
  echo "   Output: $WEB_DIR/dist"
  echo "   Size: $(du -sh dist | cut -f1)"
  
  # 部署到 nginx 目录
  echo ""
  echo "🚀 Deploying to $DEPLOY_DIR..."
  mkdir -p "$DEPLOY_DIR"
  cp -r dist/* "$DEPLOY_DIR/"
  chown -R www-data:www-data "$DEPLOY_DIR"
  
  # 刷新 nginx
  /usr/sbin/nginx -s reload
  
  echo "✅ Deployed! https://dommaker.cn is now updated"
else
  echo "❌ Build failed"
  exit 1
fi