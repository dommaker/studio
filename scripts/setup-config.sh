#!/bin/bash
# setup-config.sh — 初始化统一配置
#
# Usage: ./scripts/setup-config.sh

set -e

CONFIG_DIR="$HOME/.studio"
CONFIG_FILE="$CONFIG_DIR/config.env"
SERVICE_FILE="/etc/systemd/system/studio-api.service"

echo "=== Studio 统一配置初始化 ==="

# 1. 创建配置目录
mkdir -p "$CONFIG_DIR"

# 2. 如果 config.env 不存在，创建默认模板
if [ ! -f "$CONFIG_FILE" ]; then
    echo "Creating $CONFIG_FILE ..."
    cat > "$CONFIG_FILE" << 'EOF'
# Studio API Keys — 统一配置文件
# 修改后执行: systemctl restart studio-api

# LLM API Keys (至少配置一个)
DEEPSEEK_API_KEY=
ANTHROPIC_AUTH_TOKEN=
ANTHROPIC_BASE_URL=
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
LLM_API_KEY=
CODING_API_KEY_1=

# Discord
DISCORD_BOT_TOKEN=
DISCORD_APPLICATION_ID=
DISCORD_PUBLIC_KEY=
DISCORD_CHANNEL_ID=
DISCORD_DAILY_CHANNEL=

# Security (自动生成，通常不需要手动修改)
JWT_SECRET=
ENCRYPTION_KEY=
EOF
    echo "Created: $CONFIG_FILE"
    echo "Please edit it with your API keys."
else
    echo "Config already exists: $CONFIG_FILE"
fi

# 3. 更新 systemd service 文件
echo ""
echo "Updating systemd service ..."

# 备份原文件
if [ -f "$SERVICE_FILE" ]; then
    cp "$SERVICE_FILE" "${SERVICE_FILE}.bak.$(date +%s)"
    echo "Backed up: ${SERVICE_FILE}.bak.*"
fi

# 复制新 service 文件
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cp "$SCRIPT_DIR/studio-api.service" "$SERVICE_FILE"
echo "Updated: $SERVICE_FILE"

# 4. 重新加载 systemd
systemctl daemon-reload
echo "systemctl daemon-reload done"

# 5. 验证配置
echo ""
echo "=== 验证配置 ==="
echo "Config file: $CONFIG_FILE"
echo ""

# 检查是否有至少一个 API key 配置
if grep -qE "^(DEEPSEEK_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY|LLM_API_KEY|CODING_API_KEY_1)=" "$CONFIG_FILE"; then
    echo "✓ At least one LLM API key configured"
else
    echo "✗ No LLM API key configured!"
    echo "  Edit $CONFIG_FILE and set at least one key."
fi

echo ""
echo "=== 完成 ==="
echo ""
echo "Next steps:"
echo "  1. Edit $CONFIG_FILE with your API keys"
echo "  2. Restart API: systemctl restart studio-api"
echo "  3. Verify: studio config check"
