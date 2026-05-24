#!/bin/bash
# PostToolUse hook wrapper — 读取 stdin JSON, 提取 file_path, 调用 node sync
INPUT=$(cat 2>/dev/null || echo '{}')
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""' 2>/dev/null)

if [ -n "$FILE" ] && [ "$FILE" != "null" ]; then
  node /root/projects/studio/bin/memory-knowledge-sync.js "$FILE"
fi
