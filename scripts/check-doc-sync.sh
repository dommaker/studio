#!/bin/bash
# check-doc-sync.sh
# 检测代码变更是否需要同步更新 ARCHITECTURE.md
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
#
# 退出码:
#   0 = 无需更新（或无变更）
#   1 = 需要更新架构文档

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARCH_DOC="$PROJECT_ROOT/ARCHITECTURE.md"
BASE="${1:-main}"

if [ ! -f "$ARCH_DOC" ]; then
  echo "❌ ARCHITECTURE.md 不存在: $ARCH_DOC"
  echo "   请创建架构文档。"
  exit 1
fi

NEEDS_UPDATE=0

# 获取变更文件列表
CHANGED_FILES=""
if git rev-parse --verify "$BASE" >/dev/null 2>&1; then
  CHANGED_FILES=$(git diff --name-only "${BASE}...HEAD" 2>/dev/null || true)
fi

if [ -z "$CHANGED_FILES" ]; then
  echo "✅ 无代码变更，跳过文档同步检查"
  exit 0
fi

echo "🔍 检查架构文档同步状态..."

# --- 检查 1: @dommaker/* 依赖版本变更 ---
check_dependency_versions() {
  local pkg_files
  pkg_files=$(echo "$CHANGED_FILES" | grep 'package\.json$' || true)
  [ -z "$pkg_files" ] && return

  local doc_versions
  doc_versions=$(grep -oP '@dommaker/\S+\s+\^?[0-9]+\.[0-9]+\.[0-9]+' "$ARCH_DOC" 2>/dev/null || true)

  for pkg_file in $pkg_files; do
    if [ -f "$pkg_file" ]; then
      local changed_deps
      changed_deps=$(git diff "${BASE}...HEAD" -- "$pkg_file" 2>/dev/null | grep '^[+-].*"@dommaker/' | grep -oP '"@dommaker/[^"]+' | tr -d '"' || true)
      if [ -n "$changed_deps" ]; then
        echo "  ⚠️  $pkg_file 中 @dommaker/* 依赖已变更:"
        echo "$changed_deps" | sed 's/^/      /'
        NEEDS_UPDATE=1
      fi
    fi
  done
}

# --- 检查 2: 端口配置变更 ---
check_port_changes() {
  local port_changes
  port_changes=$(echo "$CHANGED_FILES" | grep -E '(\.env|\.env\.|server\.ts|index\.ts)$' || true)
  [ -z "$port_changes" ] && return

  local port_diffs
  port_diffs=$(git diff "${BASE}...HEAD" -- $port_changes 2>/dev/null | grep -iE '^[+-].*(PORT|port).*[0-9]{4,5}' || true)
  if [ -n "$port_diffs" ]; then
    echo "  ⚠️  检测到端口配置变更，可能需要更新 ARCHITECTURE.md 的端口分配表"
    NEEDS_UPDATE=1
  fi
}

# --- 检查 3: 新增/删除包目录 ---
check_package_structure() {
  local new_packages
  new_packages=$(echo "$CHANGED_FILES" | grep -E '^packages/[^/]+/package\.json$' | grep -v 'node_modules' || true)
  [ -z "$new_packages" ] && return

  for pkg in $new_packages; do
    local status
    status=$(git diff --name-status "${BASE}...HEAD" -- "$pkg" 2>/dev/null | head -1 | cut -f1 || true)
    if [ "$status" = "A" ]; then
      echo "  ⚠️  新增包: $pkg — 请更新 ARCHITECTURE.md"
      NEEDS_UPDATE=1
    elif [ "$status" = "D" ]; then
      echo "  ⚠️  删除包: $pkg — 请更新 ARCHITECTURE.md"
      NEEDS_UPDATE=1
    fi
  done
}

# --- 检查 4: 跨仓库接口 export 变更 ---
check_export_changes() {
  local ts_changes
  ts_changes=$(echo "$CHANGED_FILES" | grep -E '^(packages/)' | grep -E '\.(ts|tsx)$' || true)
  [ -z "$ts_changes" ] && return

  local export_diffs
  export_diffs=$(git diff "${BASE}...HEAD" -- $ts_changes 2>/dev/null | grep -E '^[+-].*export\s+(default\s+)?(class|function|interface|type|const)' || true)
  if [ -n "$export_diffs" ]; then
    echo "  ⚠️  检测到接口 export 变更，可能需要更新 ARCHITECTURE.md 的共享接口章节"
    NEEDS_UPDATE=1
  fi
}

check_dependency_versions
check_port_changes
check_package_structure
check_export_changes

echo ""
if [ "$NEEDS_UPDATE" -eq 1 ]; then
  echo "❌ 架构文档可能需要更新: $ARCH_DOC"
  echo ""
  echo "检查清单:"
  echo "  - [ ] 层级结构图是否需要更新"
  echo "  - [ ] 依赖关系是否需要更新"
  echo "  - [ ] 端口分配表是否需要更新"
  echo "  - [ ] 共享接口是否需要更新"
  echo ""
  echo "如确认无需更新，请在 PR 描述中说明原因。"
  exit 1
else
  echo "✅ 架构文档与代码一致，无需更新"
  exit 0
fi
