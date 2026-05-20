#!/bin/bash
# 生产环境部署脚本 - 打包前端 + 部署到 nginx 目录

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WEB_DIR="$PROJECT_ROOT/apps/web"
DEPLOY_DIR="/var/www/agent-studio"

echo "📦 Building + Deploying agent-studio frontend..."

cd "$WEB_DIR"

# 打包
echo "1. Building..."
npm run build

# 确认输出
if [ ! -f "dist/index.html" ]; then
  echo "❌ Build failed"
  exit 1
fi

echo "   Build size: $(du -sh dist | cut -f1)"

# 部署
echo "2. Deploying to $DEPLOY_DIR..."
mkdir -p "$DEPLOY_DIR"
rm -rf "$DEPLOY_DIR/*"  # 清理旧文件
cp -r dist/* "$DEPLOY_DIR/"
chown -R www-data:www-data "$DEPLOY_DIR"

# 刷新 nginx
echo "3. Reloading nginx..."
/usr/sbin/nginx -s reload

echo ""
echo "✅ Deployed! https://dommaker.cn is now updated"
echo "   Files: $(ls -1 "$DEPLOY_DIR/assets" | wc -l) assets + index.html"