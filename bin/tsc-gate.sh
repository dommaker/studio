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
  PKGS="apps/api,apps/web,packages/studio-shared,packages/studio-agent,packages/studio-prisma,packages/studio-skill,packages/studio-spec,packages/studio-audit,packages/studio-capability,packages/studio-monitor,packages/studio-notification,packages/studio-task"
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

echo "🔍 tsc-gate: checking packages..."
node "$REPO_ROOT/bin/tsc-gate.js" --check --baseline "$BASELINE_FILE" --packages "$PKGS"
exit $?
