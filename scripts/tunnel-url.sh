#!/bin/bash
# 提取当前 cloudflared tunnel URL + 自动更新 Discord Interactions Endpoint
# 用法: bash scripts/tunnel-url.sh              (显示当前 URL)
#       bash scripts/tunnel-url.sh --update     (自动更新 Discord endpoint)

LOG_FILE="/tmp/cloudflared.log"
APP_ID="${DISCORD_APPLICATION_ID:-1479458184837202022}"
BOT_TOKEN="${DISCORD_BOT_TOKEN}"
PROXY="${HTTPS_PROXY:-http://127.0.0.1:7890}"

URL=$(grep -oP 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' "$LOG_FILE" 2>/dev/null | tail -1)

if [ -z "$URL" ]; then
  echo "No tunnel URL found in $LOG_FILE"
  exit 1
fi

ENDPOINT="$URL/api/v1/discord/interactions"

if [ "$1" == "--update" ]; then
  if [ -z "$BOT_TOKEN" ]; then
    echo "DISCORD_BOT_TOKEN not set"
    exit 1
  fi

  # Save last known URL to detect changes
  CACHE_FILE="$HOME/.cache/cloudflared-url"
  LAST_URL=$(cat "$CACHE_FILE" 2>/dev/null)
  if [ "$URL" == "$LAST_URL" ]; then
    exit 0  # unchanged, skip
  fi

  echo "Updating Discord Interactions Endpoint..."
  echo "  $ENDPOINT"

  RESPONSE=$(curl -s --proxy "$PROXY" \
    -X PATCH "https://discord.com/api/v10/applications/$APP_ID" \
    -H "Authorization: Bot $BOT_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"interactions_endpoint_url\":\"$ENDPOINT\"}" \
    -w "\n%{http_code}")

  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  if [ "$HTTP_CODE" == "200" ]; then
    echo "$URL" > "$CACHE_FILE"
    echo "✅ Updated (HTTP $HTTP_CODE)"
  else
    echo "❌ Failed (HTTP $HTTP_CODE)"
    echo "$RESPONSE" | head -3
  fi
else
  echo "$URL"
  echo "Discord Interactions Endpoint: $ENDPOINT"
fi
