#!/bin/bash
# tsc-gate — TypeScript 类型门禁
# ================================================
#
# 对受影响包跑 tsc，任一错误即拦截 commit。
# （2026-10 #694：baseline 比对/自动更新机制删除——baseline 恒 0 空转，
#   本门禁自始等价于逐包跑 tsc。）
#
# Usage: bin/tsc-gate.sh [--all]
#   --all              Check all packages (not just staged)
#
# Set TSC_GATE_OFF=1 to skip (emergency only).
#
# 入口分工（#643 核查后保留）：本脚本是 .git/hooks/pre-commit 与人工命令行的
# tsc-gate 入口——提供 .js 没有的能力：staged 文件 → packages 范围映射、--all、
# TSC_GATE_OFF 逃生门。核心检查逻辑在 bin/tsc-gate.js；pnpm typecheck 绕过本
# 脚本直接调 .js（不带 --packages 即默认全量包）。

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHECK_ALL=false

for arg in "$@"; do
  case "$arg" in
    --all) CHECK_ALL=true ;;
  esac
done

if [ "${TSC_GATE_OFF:-}" = "1" ]; then
  echo "⚠️  TSC_GATE_OFF=1 — skipping type check"
  exit 0
fi

# Determine affected packages
if $CHECK_ALL; then
  PKGS=""  # 空 = bin/tsc-gate.js 默认全量包
else
  STAGED=$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null || true)
  if [ -z "$STAGED" ]; then
    echo "ℹ️  No staged files — skipping tsc gate"
    exit 0
  fi
  PKGS=$(node -e "
    const staged = process.argv[1].split('\n').filter(Boolean);
    const map = {};
    for (const f of staged) {
      const m = f.match(/^(apps\/[a-z]+|packages\/[a-z-]+)\//);
      if (m) map[m[1]] = true;
    }
    console.log(Object.keys(map).join(','));
  " "$STAGED")
  if [ -z "$PKGS" ]; then
    echo "ℹ️  No matching packages for staged files — skipping tsc gate"
    exit 0
  fi
fi

echo "🔍 tsc-gate: checking packages: ${PKGS:-<all>}"
if ! $CHECK_ALL; then
  # 范围按暂存文件定，判定却跑在整包活工作区上——同一台机器有并行会话时，别人半写
  # （函数体先落盘、import 行晚到）的文件会让本门禁拦下与你这次提交无关的 commit。
  echo "   注：查的是这些包的**活工作区**，不限于已暂存内容。报错文件若不在你这次的改动里，"
  echo "       先确认它是否属于别人的在写改动（重跑通常即绿），再决定要不要由你修。"
fi
node "$REPO_ROOT/bin/tsc-gate.js" --check --packages "$PKGS"
exit $?
