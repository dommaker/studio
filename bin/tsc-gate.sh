#!/bin/bash
# tsc-gate — baseline-aware TypeScript type check
# ================================================
#
# Compares current tsc output against .tsc-baseline.json.
# Blocks commit if NEW errors appear in staged files' packages.
# Pre-existing (baselined) errors pass through.
#
# Usage: bin/tsc-gate.sh [--all] [--update-baseline]
#   --all              Check all packages (not just staged)
#   --update-baseline  Rebuild .tsc-baseline.json (after fixing errors)
#
# Set TSC_GATE_OFF=1 to skip (emergency only).

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASELINE_FILE="$REPO_ROOT/.tsc-baseline.json"
CHECK_ALL=false
UPDATE_BASELINE=false

for arg in "$@"; do
  case "$arg" in
    --all) CHECK_ALL=true ;;
    --update-baseline) UPDATE_BASELINE=true ;;
  esac
done

if $UPDATE_BASELINE; then
  echo "🔄 Rebuilding .tsc-baseline.json..."
  node "$REPO_ROOT/bin/tsc-gate.js" --update-baseline --baseline "$BASELINE_FILE"
  exit $?
fi

if [ "${TSC_GATE_OFF:-}" = "1" ]; then
  echo "⚠️  TSC_GATE_OFF=1 — skipping type check"
  exit 0
fi

# Determine affected packages
if $CHECK_ALL; then
  PKGS="apps/api,apps/web,packages/studio-shared,packages/studio-agent,packages/studio-skill,packages/studio-spec,packages/studio-audit,packages/studio-capability,packages/studio-notification"
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

echo "🔍 tsc-gate: checking packages: $PKGS"
if ! $CHECK_ALL; then
  # 范围按暂存文件定，判定却跑在整包活工作区上——同一台机器有并行会话时，别人半写
  # （函数体先落盘、import 行晚到）的文件会让本门禁拦下与你这次提交无关的 commit。
  echo "   注：查的是这些包的**活工作区**，不限于已暂存内容。报错文件若不在你这次的改动里，"
  echo "       先确认它是否属于别人的在写改动（重跑通常即绿），再决定要不要由你修。"
fi
node "$REPO_ROOT/bin/tsc-gate.js" --check --baseline "$BASELINE_FILE" --packages "$PKGS"
exit $?
