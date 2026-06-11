#!/usr/bin/env bash
# ci-doc-freshness-check.sh — CI script for doc-freshness detection
# Input: git diff (changed files list via --changed-files or stdin)
# Output: structured JSON report to stdout
# Exit: 0 = no diffs, 1 = diffs found

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$HOME/.studio/skills/always/doc-freshness"
PROJECT_PATH="/root/projects/studio"
CHANGED_FILES=""
DATE="$(date +%Y-%m-%d)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --changed-files) CHANGED_FILES="$2"; shift 2 ;;
    --project-path) PROJECT_PATH="$2"; shift 2 ;;
    --date) DATE="$2"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done

# If no changed-files provided, get from git diff
if [[ -z "$CHANGED_FILES" ]]; then
  CHANGED_FILES="$(git -C "$PROJECT_PATH" diff --name-only HEAD~1 HEAD 2>/dev/null | tr '\n' ',')"
  CHANGED_FILES="${CHANGED_FILES%,}"  # trim trailing comma
fi

if [[ -z "$CHANGED_FILES" ]]; then
  echo '{"totalDiffs":0,"scannedDocs":[],"diffs":[],"message":"无变更文件"}'
  exit 0
fi

# Step 1: Map changed files → affected docs
AFFECTED_DOCS="$(bash "$SKILL_DIR/scripts/map-files-to-docs.sh" \
  --files "$CHANGED_FILES" \
  --project "$PROJECT_PATH" 2>/dev/null || true)"

if [[ -z "$AFFECTED_DOCS" ]]; then
  echo '{"totalDiffs":0,"scannedDocs":[],"diffs":[],"message":"无受影响文档"}'
  exit 0
fi

# Step 2: Run doc-freshness-check on each affected doc
ALL_DIFFS="[]"
SCANNED_DOCS="[]"
TOTAL_DIFFS=0

while IFS= read -r doc; do
  [[ -z "$doc" ]] && continue

  # Run harness doc-freshness-check
  RESULT="$(harness doc-freshness-check "$doc" \
    --format json \
    --changed-files "$CHANGED_FILES" \
    --project-path "$PROJECT_PATH" 2>/dev/null || echo '{"error":"command failed"}')"

  # Append to scanned docs
  SCANNED_DOCS="$(echo "$SCANNED_DOCS" | jq --arg d "$doc" '. + [$d]')"

  # Extract diffs from result
  DOC_DIFFS="$(echo "$RESULT" | jq -r '.diffs // []' 2>/dev/null || echo '[]')"
  DOC_COUNT="$(echo "$DOC_DIFFS" | jq 'length' 2>/dev/null || echo 0)"

  if [[ "$DOC_COUNT" -gt 0 ]]; then
    ALL_DIFFS="$(echo "$ALL_DIFFS" "$DOC_DIFFS" | jq -s '.[0] + .[1]')"
    TOTAL_DIFFS=$((TOTAL_DIFFS + DOC_COUNT))
  fi
done <<< "$AFFECTED_DOCS"

# Step 3: Also check spec baselines for docs/specs/ files
BASELINE_CHECKS="[]"
while IFS= read -r doc; do
  [[ -z "$doc" ]] && continue
  # Only check specs with baseline sections
  if [[ "$doc" == *"/docs/specs/"* ]]; then
    if grep -qlE '## Baseline|## 前置条件' "$doc" 2>/dev/null; then
      BASELINE_RESULT="$(harness spec-baseline-check "$doc" \
        --json \
        --project-path "$PROJECT_PATH" 2>/dev/null || echo '{"passed":false,"failures":["command failed"]}')"
      BASELINE_CHECKS="$(echo "$BASELINE_CHECKS" | jq --argjson check "$BASELINE_RESULT" '. + [$check]')"
    fi
  fi
done <<< "$AFFECTED_DOCS"

# Build final report
REPORT="$(jq -n \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg project "$PROJECT_PATH" \
  --arg date "$DATE" \
  --argjson scanned "$SCANNED_DOCS" \
  --argjson total "$TOTAL_DIFFS" \
  --argjson diffs "$ALL_DIFFS" \
  --argjson baselines "$BASELINE_CHECKS" \
  '{
    timestamp: $ts,
    projectPath: $project,
    date: $date,
    scannedDocs: $scanned,
    summary: {
      totalDiffs: $total,
      numeric: ([$diffs[] | select(.type == "numeric")] | length),
      status: ([$diffs[] | select(.type == "status")] | length),
      narrative: ([$diffs[] | select(.type == "narrative")] | length)
    },
    diffs: $diffs,
    baselineChecks: $baselines
  }')"

echo "$REPORT"

if [[ "$TOTAL_DIFFS" -gt 0 ]]; then
  exit 1
else
  exit 0
fi
