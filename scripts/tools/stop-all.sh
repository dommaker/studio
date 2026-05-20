#!/bin/bash
#
# Agent Studio 全栈停止脚本
# 用法: ./scripts/stop-all.sh
#

set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

LOG_DIR="/tmp/agent-studio-logs"

log_info() {
  echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

log_step() {
  echo -e "${BLUE}==>${NC} $1"
}

# 停止端口上的服务
stop_port() {
  local port=$1
  local name=$2
  
  local pids=$(lsof -t -i :$port 2>/dev/null || true)
  
  if [ -n "$pids" ]; then
    log_step "停止 $name (端口 $port)..."
    echo "$pids" | xargs kill -9 2>/dev/null || true
    log_info "$name 已停止"
  else
    log_warn "$name 未运行（端口 $port）"
  fi
}

# 停止监控服务
stop_monitoring() {
  log_step "停止监控服务..."
  
  if docker ps --format '{{.Names}}' | grep -q "agent-studio-prometheus"; then
    docker stop agent-studio-prometheus >/dev/null
    log_info "Prometheus 已停止"
  else
    log_warn "Prometheus 未运行"
  fi
  
  if docker ps --format '{{.Names}}' | grep -q "agent-studio-grafana"; then
    docker stop agent-studio-grafana >/dev/null
    log_info "Grafana 已停止"
  else
    log_warn "Grafana 未运行"
  fi
}

# 清理 PID 文件
cleanup_pids() {
  rm -f "$LOG_DIR"/*.pid 2>/dev/null || true
}

# 主流程
main() {
  log_info "停止 Agent Studio 全栈服务..."
  echo ""
  
  stop_port 5174 "前端"
  stop_port 3001 "agent-studio"
  stop_port 3002 "agent-runtime"
  stop_monitoring
  cleanup_pids
  
  echo ""
  log_info "所有服务已停止"
}

main