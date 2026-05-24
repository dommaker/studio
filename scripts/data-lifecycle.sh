#!/bin/bash
# G32: Nightly data lifecycle — backup to COS, then cleanup local
set -e

# 配置方式: export DATA_COS_BUCKET="tencent-cos:your-bucket-name"
COS_BUCKET="${DATA_COS_BUCKET:?DATA_COS_BUCKET env var required}"
DATE=$(date +%Y-%m-%d)

echo "[$(date)] Starting data lifecycle..."

# 1. Backup knowledge base to COS
echo "Backing up knowledge-base..."
rclone sync ~/knowledge-base "$COS_BUCKET/knowledge-base" --progress 2>&1 | tail -3

# 2. Backup studio data to COS
echo "Backing up studio data..."
rclone sync ~/.studio "$COS_BUCKET/studio/$DATE" --progress 2>&1 | tail -3

# 3. Backup events to COS
echo "Backing up events..."
rclone sync ~/events "$COS_BUCKET/events/$DATE" --progress 2>&1 | tail -3

# 4. Truncate local files > 7 days old
STUDIO_JSONL=~/events/studio.jsonl
if [ -f "$STUDIO_JSONL" ]; then
  tail -n 2000 "$STUDIO_JSONL" > "${STUDIO_JSONL}.tmp" && mv "${STUDIO_JSONL}.tmp" "$STUDIO_JSONL"
fi

echo "[$(date)] Data lifecycle complete"
