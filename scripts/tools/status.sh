#!/bin/bash
#
# Agent Studio 服务状态检查脚本
# 用法: ./scripts/status.sh
#

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# 检查端口
check_port() {
  local port=$1
  lsof -i :$port >/dev/null 2>&1
}

# 检查健康状态
check_health() {
  local url=$1
  curl -s -f "$url" >/dev/null 2>&1
}

# 获取进程信息
get_process_info() {
  local port=$1
  local pid=$(lsof -t -i :$port 2>/dev/null | head -1)
  
  if [ -n "$pid" ]; then
    local cmd=$(ps -p $pid -o comm= 2>/dev/null || echo "unknown")
    local mem=$(ps -p $pid -o rss= 2>/dev/null | awk '{printf "%.1f MB", $1/1024}')
    echo "$pid | $cmd | $mem"
  else
    echo "N/A"
  fi
}

# 主流程
main() {
  echo -e "${BLUE}========================================${NC}"
  echo -e "${BLUE}   Agent Studio 服务状态${NC}"
  echo -e "${BLUE}========================================${NC}"
  echo ""
  
  # agent-studio-api (production=13101, dev=13001)
  PROD_PORT="${PORT:-3001}"
  DEV_PORT="${PORT:-3001}"
  PORT="${PORT:-3001}"
  if ! check_port $PROD_PORT && check_port $DEV_PORT; then
    PORT=$DEV_PORT
  fi

  echo -e "${YELLOW}agent-studio-api (端口 $PORT)${NC}"
  if check_port $PORT; then
    echo -e "  状态:  ${GREEN}✓ 运行中${NC}"
    echo -e "  URL:   http://localhost:$PORT"
    echo -e "  进程:  $(get_process_info $PORT)"

    if check_health "http://localhost:$PORT/health"; then
      echo -e "  健康:  ${GREEN}✓ 正常${NC}"
    else
      echo -e "  健康:  ${RED}✗ 异常${NC}"
    fi
  else
    echo -e "  状态:  ${RED}✗ 未运行${NC}"
  fi
  echo ""
  
  # 前端
  echo -e "${YELLOW}前端 (端口 5174)${NC}"
  if check_port 5174; then
    echo -e "  状态:  ${GREEN}✓ 运行中${NC}"
    echo -e "  URL:   http://localhost:5174"
    echo -e "  进程:  $(get_process_info 5174)"
  else
    echo -e "  状态:  ${YELLOW}○ 未运行${NC}"
  fi
  echo ""
  
  # Prometheus
  echo -e "${YELLOW}Prometheus (端口 9090)${NC}"
  if check_port 9090; then
    echo -e "  状态:  ${GREEN}✓ 运行中${NC}"
    echo -e "  URL:   http://localhost:9090"
    
    # 检查目标状态
    local targets=$(curl -s 'http://localhost:9090/api/v1/targets' 2>/dev/null | jq -r '.data.activeTargets | length' 2>/dev/null || echo "?")
    local up=$(curl -s 'http://localhost:9090/api/v1/query?query=up' 2>/dev/null | jq -r '.data.result | map(select(.value[1] == "1")) | length' 2>/dev/null || echo "?")
    echo -e "  目标:  $up/$targets 在线"
  else
    echo -e "  状态:  ${YELLOW}○ 未运行${NC}"
  fi
  echo ""
  
  # Grafana
  echo -e "${YELLOW}Grafana (端口 3030)${NC}"
  if check_port 3030; then
    echo -e "  状态:  ${GREEN}✓ 运行中${NC}"
    echo -e "  URL:   http://localhost:3030"
    echo -e "  登录:  admin / (见 GRAFANA_ADMIN_PASSWORD 环境变量)"
    
    if check_health "http://localhost:3030/api/health"; then
      echo -e "  健康:  ${GREEN}✓ 正常${NC}"
    else
      echo -e "  健康:  ${RED}✗ 异常${NC}"
    fi
  else
    echo -e "  状态:  ${YELLOW}○ 未运行${NC}"
  fi
  echo ""
  
  # 快速命令
  echo -e "${BLUE}========================================${NC}"
  echo -e "快速命令:"
  echo -e "  启动:   ./scripts/start-all.sh"
  echo -e "  停止:   ./scripts/stop-all.sh"
  echo -e "  状态:   ./scripts/status.sh"
  echo -e "  日志:   tail -f /tmp/agent-studio-logs/*.log"
  echo -e "${BLUE}========================================${NC}"
}

main