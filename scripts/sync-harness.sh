#!/bin/bash
# sync-harness.sh — 同步 @dommaker/harness 到 agent-studio
#
# 在 harness 有改动后运行:
#   cd /root/projects/harness && npx tsc
#   bash /root/projects/agent-studio/scripts/sync-harness.sh
#
# 飞轮: harness change → build → sync → agent-studio 即时生效

set -e

HARNESS_SRC="/root/projects/harness"
AGENT_STUDIO="/root/projects/agent-studio"
TARGET="$AGENT_STUDIO/node_modules/@dommaker/harness"

echo "🔧 [Harness Sync] Syncing from $HARNESS_SRC → $TARGET"

# 1. Verify harness dist exists
if [ ! -f "$HARNESS_SRC/dist/index.js" ]; then
  echo "❌ Harness dist not found. Run: cd $HARNESS_SRC && npx tsc"
  exit 1
fi

# 2. Copy dist + metadata
mkdir -p "$TARGET"
cp "$HARNESS_SRC/package.json" "$TARGET/"
cp -r "$HARNESS_SRC/dist" "$TARGET/"
[ -d "$HARNESS_SRC/bin" ] && cp -r "$HARNESS_SRC/bin" "$TARGET/"
[ -d "$HARNESS_SRC/templates" ] && cp -r "$HARNESS_SRC/templates" "$TARGET/"

# 3. Verify
VERSION=$(node -e "console.log(require('$TARGET/package.json').version)")
echo "✅ [Harness Sync] Done — version $VERSION synced"
echo "   Run 'pnpm build' in affected packages if needed."
