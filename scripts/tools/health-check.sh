#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# 部署后健康检查脚本
# 检查所有服务是否正常运行

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

ERRORS=0

echo "🔍 开始健康检查..."
echo ""

# 1. 检查服务端口
echo "📋 1. 服务端口状态"
check_port() {
  local name=$1
  local port=$2
  if ss -tlnp 2>/dev/null | grep -q ":$port "; then
    echo "  ${GREEN}✓${NC} $name (port $port): running"
  else
    echo "  ${RED}✗${NC} $name (port $port): stopped"
  fi
}
check_port "agent-studio-api" "${PORT:-3001}"
check_port "agent-studio-api (dev)" "${PORT:-3001}"
echo ""

# 2. 检查 API 健康端点
echo "📋 2. API 健康检查"

check_health() {
  local name=$1
  local url=$2

  response=$(curl -s -w "\n%{http_code}" "$url" 2>/dev/null || echo -e "\n000")
  http_code=$(echo "$response" | tail -1)
  body=$(echo "$response" | head -n -1)

  if [ "$http_code" = "200" ]; then
    if echo "$body" | jq -e '.status == "ok"' >/dev/null 2>&1; then
      echo "  ${GREEN}✓${NC} $name: OK"
    else
      echo "  ${YELLOW}⚠${NC} $name: 返回 200 但 status 不是 ok"
      ERRORS=$((ERRORS + 1))
    fi
  else
    echo "  ${RED}✗${NC} $name: HTTP $http_code"
    ERRORS=$((ERRORS + 1))
  fi
}

check_health "agent-studio-api" "http://localhost:${PORT:-3001}/health"
echo ""

# 3. 检查前端静态资源
echo "📋 3. 前端静态资源"

check_frontend() {
  local url=$1

  response=$(curl -s -w "\n%{http_code}" "$url" 2>/dev/null || echo -e "\n000")
  http_code=$(echo "$response" | tail -1)
  body=$(echo "$response" | head -n -1)

  if [ "$http_code" = "200" ]; then
    if echo "$body" | grep -q "<!doctype html"; then
      echo "  ${GREEN}✓${NC} 前端页面: OK"
    else
      echo "  ${RED}✗${NC} 前端页面: 非 HTML 响应"
      ERRORS=$((ERRORS + 1))
    fi
  else
    echo "  ${RED}✗${NC} 前端页面: HTTP $http_code"
    ERRORS=$((ERRORS + 1))
  fi
}

check_frontend "http://localhost:5173/"
echo ""

# 4. 检查关键 API 端点
echo "📋 4. 关键 API 端点"

check_api() {
  local name=$1
  local url=$2
  local check_array=$3

  response=$(curl -s -w "\n%{http_code}" "$url" 2>/dev/null || echo -e "\n000")
  http_code=$(echo "$response" | tail -1)
  body=$(echo "$response" | head -n -1)

  if [ "$http_code" = "200" ]; then
    if [ "$check_array" = "true" ]; then
      if echo "$body" | jq -e 'type == "array" or .data | type == "array"' >/dev/null 2>&1; then
        count=$(echo "$body" | jq 'if type == "array" then length else .data | length end' 2>/dev/null || echo "0")
        echo "  ${GREEN}✓${NC} $name: $count 条记录"
      else
        echo "  ${YELLOW}⚠${NC} $name: 返回格式不符合预期"
      fi
    else
      echo "  ${GREEN}✓${NC} $name: OK"
    fi
  else
    echo "  ${RED}✗${NC} $name: HTTP $http_code"
    ERRORS=$((ERRORS + 1))
  fi
}

check_api "工作流列表" "http://localhost:${PORT:-3001}/api/v1/runtime/workflows" "true"
check_api "步骤列表" "http://localhost:${PORT:-3001}/api/v1/runtime/steps" "true"
check_api "工具列表" "http://localhost:${PORT:-3001}/api/v1/runtime/tools" "true"
check_api "角色列表" "http://localhost:${PORT:-3001}/api/v1/roles?companyId=${COMPANY_ID}" "true"
echo ""

# 5. 检查数据库连接
echo "📋 5. 数据库连接"

db_check=$(curl -s "http://localhost:${PORT:-3001}/api/v1/roles?companyId=${COMPANY_ID}" | jq '.data | length' 2>/dev/null || echo "0")

if [ "$db_check" != "0" ]; then
  echo "  ${GREEN}✓${NC} PostgreSQL: 连接正常"
else
  echo "  ${RED}✗${NC} PostgreSQL: 连接失败"
  ERRORS=$((ERRORS + 1))
fi
echo ""

# 6. 检查环境变量
echo "📋 6. 环境变量检查"

if [ -f "$PROJECT_ROOT/apps/web/.env.production" ]; then
  echo "  ${GREEN}✓${NC} .env.production 存在"

  if grep -q "VITE_API_URL" $PROJECT_ROOT/apps/web/.env.production; then
    api_url=$(grep "VITE_API_URL" $PROJECT_ROOT/apps/web/.env.production | cut -d'=' -f2)
    echo "  ${GREEN}✓${NC} VITE_API_URL: $api_url"
  else
    echo "  ${RED}✗${NC} VITE_API_URL 未配置"
    ERRORS=$((ERRORS + 1))
  fi
else
  echo "  ${RED}✗${NC} .env.production 不存在"
  ERRORS=$((ERRORS + 1))
fi
echo ""

# 7. 检查公网访问（如果配置了公网 IP）
echo "📋 7. 公网访问检查"

PUBLIC_IP=$(curl -s ifconfig.me 2>/dev/null || echo "")

if [ -n "$PUBLIC_IP" ]; then
  echo "  公网 IP: $PUBLIC_IP"

  # 检查端口是否开放
  for port in 3001 5173; do
    if lsof -i :$port >/dev/null 2>&1; then
      echo "  ${GREEN}✓${NC} 端口 $port: 监听中"
    else
      echo "  ${RED}✗${NC} 端口 $port: 未监听"
      ERRORS=$((ERRORS + 1))
    fi
  done
else
  echo "  ${YELLOW}⚠${NC} 无法获取公网 IP"
fi
echo ""

# 8. 检查日志错误
echo "📋 8. 最近日志错误"

api_errors=$(grep -i "error" /tmp/studio-api-prod.log 2>/dev/null | tail -100 | wc -l || echo "0")

if [ "$api_errors" -gt 10 ]; then
  echo "  ${YELLOW}⚠${NC} agent-studio-api: $api_errors 个错误"
else
  echo "  ${GREEN}✓${NC} agent-studio-api: $api_errors 个错误"
fi

if [ "$api_errors" -gt 10 ]; then
  echo "  ${YELLOW}⚠${NC} agent-studio-api: $api_errors 个错误"
else
  echo "  ${GREEN}✓${NC} agent-studio-api: $api_errors 个错误"
fi
echo ""

# 总结
echo "================================"
if [ $ERRORS -eq 0 ]; then
  echo "${GREEN}✅ 所有检查通过！${NC}"
  exit 0
else
  echo "${RED}✗ 发现 $ERRORS 个问题${NC}"
  exit 1
fi
