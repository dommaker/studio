#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# 环境变量验证脚本
# 在构建前检查必要的环境变量是否配置正确

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ERRORS=0

echo "🔍 环境变量验证"
echo ""

# 检查 .env.production 文件
ENV_FILE="$PROJECT_ROOT/apps/web/.env.production"

if [ ! -f "$ENV_FILE" ]; then
  echo "${RED}✗ .env.production 文件不存在${NC}"
  echo ""
  echo "请创建 .env.production 文件，内容示例："
  echo ""
  echo "VITE_API_URL=http://YOUR_PUBLIC_IP:3001/api/v1"
  echo "VITE_RUNTIME_API_URL=http://YOUR_PUBLIC_IP:3002/api/v1"
  echo ""
  ERRORS=$((ERRORS + 1))
else
  echo "${GREEN}✓ .env.production 文件存在${NC}"
  echo ""

  # 检查必要变量
  echo "📋 必要变量检查:"
  echo ""

  # VITE_API_URL
  if grep -q "^VITE_API_URL=" "$ENV_FILE"; then
    API_URL=$(grep "^VITE_API_URL=" "$ENV_FILE" | cut -d'=' -f2-)

    if [ -z "$API_URL" ]; then
      echo "  ${RED}✗ VITE_API_URL: 空值${NC}"
      ERRORS=$((ERRORS + 1))
    elif echo "$API_URL" | grep -q "localhost"; then
      echo "  ${YELLOW}⚠ VITE_API_URL: 使用 localhost ($API_URL)${NC}"
      echo "    提示: 生产环境应使用公网 IP 或域名"
    else
      echo "  ${GREEN}✓ VITE_API_URL: $API_URL${NC}"

      # 验证 URL 格式
      if echo "$API_URL" | grep -qE "^https?://.+:/api/v1$"; then
        echo "    ${GREEN}✓ URL 格式正确${NC}"
      else
        echo "    ${YELLOW}⚠ URL 格式可能不正确，建议: http://IP:PORT/api/v1${NC}"
      fi
    fi
  else
    echo "  ${RED}✗ VITE_API_URL: 未配置${NC}"
    ERRORS=$((ERRORS + 1))
  fi

  # VITE_RUNTIME_API_URL
  if grep -q "^VITE_RUNTIME_API_URL=" "$ENV_FILE"; then
    RUNTIME_URL=$(grep "^VITE_RUNTIME_API_URL=" "$ENV_FILE" | cut -d'=' -f2-)

    if [ -n "$RUNTIME_URL" ]; then
      echo "  ${GREEN}✓ VITE_RUNTIME_API_URL: $RUNTIME_URL${NC}"
    else
      echo "  ${YELLOW}⚠ VITE_RUNTIME_API_URL: 空值${NC}"
    fi
  else
    echo "  ${YELLOW}⚠ VITE_RUNTIME_API_URL: 未配置（可选）${NC}"
  fi

  echo ""

  # 检查其他变量
  echo "📋 可选变量检查:"
    # 检查是否有敏感信息
  if grep -qE "password|secret|token|key" "$ENV_FILE" -i; then
    echo "  ${YELLOW}⚠ 检测到可能的敏感信息，请确保 .env.production 不被提交到 Git${NC}"
  fi
  echo ""
fi

# 检查后端环境变量
BACKEND_ENV="$PROJECT_ROOT/.env"

echo "📋 后端环境变量:"

if [ -f "$BACKEND_ENV" ]; then
  # DATABASE_URL
  if grep -q "^DATABASE_URL=" "$BACKEND_ENV"; then
    echo "  ${GREEN}✓ DATABASE_URL: 已配置${NC}"
  else
    echo "  ${YELLOW}⚠ DATABASE_URL: 未配置${NC}"
  fi

  # REDIS_URL
  if grep -q "^REDIS_URL=" "$BACKEND_ENV"; then
    echo "  ${GREEN}✓ REDIS_URL: 已配置${NC}"
  else
    echo "  ${YELLOW}⚠ REDIS_URL: 未配置（可选）${NC}"
  fi

else
  echo "  ${YELLOW}⚠ 后端 .env 文件不存在${NC}"
fi

echo ""

# 检查 .gitignore
echo "📋 Git 忽略检查:"

GITIGNORE="$PROJECT_ROOT/.gitignore"

if [ -f "$GITIGNORE" ]; then
  if grep -q ".env" "$GITIGNORE"; then
    echo "  ${GREEN}✓ .env 已在 .gitignore 中${NC}"
  else
    echo "  ${RED}✗ .env 未在 .gitignore 中${NC}"
    echo "    请添加 .env 和 .env.local 到 .gitignore"
    ERRORS=$((ERRORS + 1))
  fi

  if grep -q ".env.production" "$GITIGNORE"; then
    echo "  ${YELLOW}⚠ .env.production 在 .gitignore 中${NC}"
    echo "    注意: .env.production 通常需要提交（不含敏感信息）"
  else
    echo "  ${GREEN}✓ .env.production 不在 .gitignore 中（正确）${NC}"
  fi
else
  echo "  ${YELLOW}⚠ .gitignore 文件不存在${NC}"
fi

echo ""

# 总结
echo "================================"
if [ $ERRORS -eq 0 ]; then
  echo "${GREEN}✅ 环境变量验证通过！${NC}"
  exit 0
else
  echo "${RED}✗ 发现 $ERRORS 个问题${NC}"
  exit 1
fi
