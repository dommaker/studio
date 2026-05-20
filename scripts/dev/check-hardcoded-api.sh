#!/bin/bash
# CI 检查：硬编码 API 地址

echo "🔍 检查硬编码 API 地址..."

# 检查 localhost:13101 硬编码
LOCALHOST_COUNT=$(grep -r "localhost:13101" apps/web/src --include="*.ts" --include="*.tsx" | wc -l)

if [ "$LOCALHOST_COUNT" -gt 0 ]; then
  echo "❌ 发现 localhost:13101 硬编码：$LOCALHOST_COUNT 处"
  grep -rn "localhost:13101" apps/web/src --include="*.ts" --include="*.tsx"
  exit 1
fi

# 检查 API_BASE 单独定义（应使用 api/index.ts）
API_BASE_COUNT=$(grep -rn "API_BASE.*=" apps/web/src --include="*.ts" --include="*.tsx" | grep -v "api/index.ts" | grep -v "workflowEditorStore.ts" | wc -l)

if [ "$API_BASE_COUNT" -gt 0 ]; then
  echo "⚠️ 发现 API_BASE 单独定义：$API_BASE_COUNT 处（应使用 api/index.ts）"
  grep -rn "API_BASE.*=" apps/web/src --include="*.ts" --include="*.tsx" | grep -v "api/index.ts" | grep -v "workflowEditorStore.ts"
  # 仅警告，不退出
fi

echo "✅ 无硬编码问题"
exit 0