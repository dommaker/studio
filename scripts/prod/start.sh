#!/bin/bash
# 生产环境启动脚本 - 打包前端 + 启动后端 API

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
API_DIR="$PROJECT_ROOT/apps/api"
WEB_DIR="$PROJECT_ROOT/apps/web"
ENV_FILE="$PROJECT_ROOT/.env.production"
[ -f "$ENV_FILE" ] && source "$ENV_FILE"
DEPLOY_DIR="/var/www/agent-studio"
API_PORT="${PORT:-3001}"

echo "🚀 Starting agent-studio (production)"
echo "   API:     http://localhost:$API_PORT"
echo "   Web:     https://dommaker.cn (nginx static)"

# ============================================
# 1. 打包部署前端
# ============================================
echo ""
echo "📦 Step 1: Building frontend..."
cd "$WEB_DIR"
npm run build

if [ ! -f "dist/index.html" ]; then
  echo "❌ Build failed"
  exit 1
fi

echo "   Build size: $(du -sh dist | cut -f1)"

echo "   Deploying to $DEPLOY_DIR..."
mkdir -p "$DEPLOY_DIR"
rm -rf "$DEPLOY_DIR/*"
cp -r dist/* "$DEPLOY_DIR/"
chown -R www-data:www-data "$DEPLOY_DIR"
echo "   Files: $(ls -1 "$DEPLOY_DIR/assets" | wc -l) assets + index.html"

# ============================================
# 2. 启动后端服务
# ============================================
echo ""
echo "🔧 Step 2: Starting backend services..."

# 复制环境配置
cp "$ENV_FILE" "$API_DIR/.env"

# 数据库迁移（幂等，已应用的会跳过）
echo "   Applying Prisma migrations..."
cd "$PROJECT_ROOT/packages/studio-prisma"
DATABASE_URL="file:$HOME/.studio/data/data.db" npx prisma migrate deploy 2>&1 | sed 's/^/   /'

# 启动后端 API
cd "$API_DIR"
nohup npx tsx src/index.ts > /tmp/studio-api-prod.log 2>&1 &
API_PID=$!
echo "   API PID: $API_PID"

# ============================================
# 3. 检查服务状态
# ============================================
echo ""
echo "🔍 Step 3: Checking services..."

# 刷新 nginx
/usr/sbin/nginx -s reload 2>/dev/null || true

# 等待服务启动
sleep 3

if ss -tlnp | grep -q ":$API_PORT"; then
  echo "✅ API running (port $API_PORT)"
else
  echo "❌ Failed to start API"
  tail -20 /tmp/studio-api-prod.log
  exit 1
fi

echo ""
echo "✅ Production services started!"
echo "   Frontend: https://dommaker.cn"
echo "   API:      http://localhost:$API_PORT"
