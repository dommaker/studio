#!/bin/bash
#
# Agent Studio 全栈启动脚本
# 用法: ./scripts/start-all.sh [--skip-frontend] [--skip-monitoring] [--daemon]
#

set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 默认配置
SKIP_FRONTEND=false
SKIP_MONITORING=false
DAEMON_MODE=false
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECTS_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOG_DIR="/tmp/agent-studio-logs"

# 解析参数
while [[ $# -gt 0 ]]; do
  case $1 in
    --skip-frontend)
      SKIP_FRONTEND=true
      shift
      ;;
    --skip-monitoring)
      SKIP_MONITORING=true
      shift
      ;;
    --daemon)
      DAEMON_MODE=true
      shift
      ;;
    --help)
      echo "用法: $0 [选项]"
      echo ""
      echo "选项:"
      echo "  --skip-frontend    跳过前端启动"
      echo "  --skip-monitoring  跳过监控服务"
      echo "  --daemon           后台运行模式"
      echo "  --help             显示帮助信息"
      exit 0
      ;;
    *)
      echo "未知参数: $1"
      exit 1
      ;;
  esac
done

# 创建日志目录
mkdir -p "$LOG_DIR"

# 日志函数
log_info() {
  echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

log_step() {
  echo -e "${BLUE}==>${NC} $1"
}

# 检查服务是否运行
check_port() {
  local port=$1
  lsof -i :$port >/dev/null 2>&1
}

# 等待服务启动
wait_for_port() {
  local port=$1
  local name=$2
  local max_wait=30
  local count=0
  
  while ! check_port $port; do
    sleep 1
    count=$((count + 1))
    if [ $count -ge $max_wait ]; then
      log_error "$name 启动超时（端口 $port）"
      return 1
    fi
  done
  log_info "$name 已启动（端口 $port）"
  return 0
}

# 停止已运行的服务
stop_if_running() {
  local port=$1
  local name=$2
  
  if check_port $port; then
    log_warn "$name 已在运行（端口 $port），跳过"
    return 0
  fi
  return 1
}

# agent-runtime 已移除 (runtime-proxy 下线 2026-05-14)
# 保留函数占位供未来扩展

# 启动 agent-studio 后端
start_studio_backend() {
  log_step "启动 agent-studio 后端..."
  
  if stop_if_running 3001 "agent-studio"; then
    return 0
  fi
  
  cd "$PROJECTS_DIR/agent-studio"
  
  # 检查数据库
  if [ ! -f "prisma/dev.db" ]; then
    log_info "初始化数据库..."
    npx prisma migrate dev --name init 2>/dev/null || true
  fi
  
  if [ "$DAEMON_MODE" = true ]; then
    nohup npm run dev > "$LOG_DIR/studio.log" 2>&1 &
    echo $! > "$LOG_DIR/studio.pid"
  else
    npm run dev &
  fi
  
  wait_for_port 3001 "agent-studio"
}

# 启动前端
start_frontend() {
  if [ "$SKIP_FRONTEND" = true ]; then
    log_warn "跳过前端启动"
    return 0
  fi
  
  log_step "启动前端..."
  
  if stop_if_running 5174 "前端"; then
    return 0
  fi
  
  cd "$PROJECTS_DIR/agent-studio/frontend"
  
  if [ "$DAEMON_MODE" = true ]; then
    nohup npm run dev > "$LOG_DIR/frontend.log" 2>&1 &
    echo $! > "$LOG_DIR/frontend.pid"
  else
    npm run dev &
  fi
  
  wait_for_port 5174 "前端"
}

# 启动监控服务
start_monitoring() {
  if [ "$SKIP_MONITORING" = true ]; then
    log_warn "跳过监控服务"
    return 0
  fi
  
  log_step "启动监控服务..."
  
  # 检查 Docker 是否运行
  if ! docker info >/dev/null 2>&1; then
    log_error "Docker 未运行，无法启动监控服务"
    return 1
  fi
  
  # Prometheus
  if docker ps --format '{{.Names}}' | grep -q "agent-studio-prometheus"; then
    log_warn "Prometheus 已在运行，跳过"
  else
    log_info "启动 Prometheus..."
    if [ "$(docker ps -aq -f name=agent-studio-prometheus)" ]; then
      docker start agent-studio-prometheus
    else
      docker run -d --name agent-studio-prometheus \
        -p 9090:9090 \
        -v "$PROJECTS_DIR/agent-studio/prometheus.yml:/etc/prometheus/prometheus.yml:ro" \
        -v "$PROJECTS_DIR/agent-studio/alerts.yml:/etc/prometheus/alerts.yml:ro" \
        prom/prometheus:v2.48.0 \
        --config.file=/etc/prometheus/prometheus.yml \
        --storage.tsdb.retention.time=30d
    fi
  fi
  
  # Grafana
  if docker ps --format '{{.Names}}' | grep -q "agent-studio-grafana"; then
    log_warn "Grafana 已在运行，跳过"
  else
    log_info "启动 Grafana..."
    if [ "$(docker ps -aq -f name=agent-studio-grafana)" ]; then
      docker start agent-studio-grafana
    else
      docker run -d --name agent-studio-grafana \
        -p 3030:3000 \
        -v "$PROJECTS_DIR/agent-studio/grafana/datasources:/etc/grafana/provisioning/datasources:ro" \
        -e GF_SECURITY_ADMIN_PASSWORD=admin123 \
        -e GF_USERS_ALLOW_SIGN_UP=false \
        grafana/grafana:10.2.0
    fi
  fi
  
  log_info "监控服务已启动"
}

# 打印状态
print_status() {
  echo ""
  echo -e "${GREEN}========================================${NC}"
  echo -e "${GREEN}   Agent Studio 全栈启动完成${NC}"
  echo -e "${GREEN}========================================${NC}"
  echo ""
  echo -e "服务状态:"
  echo ""
  
  # 检查各服务状态
  if check_port 3002; then
    echo -e "  ${GREEN}✓${NC} agent-runtime    http://localhost:3002"
    echo -e "    └─ 指标: http://localhost:3002/metrics"
  else
    echo -e "  ${RED}✗${NC} agent-runtime    未启动"
  fi
  
  if check_port 3001; then
    echo -e "  ${GREEN}✓${NC} agent-studio    http://localhost:3001"
    echo -e "    └─ 指标: http://localhost:3001/metrics"
  else
    echo -e "  ${RED}✗${NC} agent-studio    未启动"
  fi
  
  if check_port 5174; then
    echo -e "  ${GREEN}✓${NC} 前端            http://localhost:5174"
  else
    echo -e "  ${YELLOW}○${NC} 前端            未启动（或已跳过）"
  fi
  
  if check_port 9090; then
    echo -e "  ${GREEN}✓${NC} Prometheus      http://localhost:9090"
  else
    echo -e "  ${YELLOW}○${NC} Prometheus      未启动（或已跳过）"
  fi
  
  if check_port 3030; then
    echo -e "  ${GREEN}✓${NC} Grafana         http://localhost:3030 (admin/admin123)"
    echo -e "    └─ Dashboard: /d/agent-studio-overview"
  else
    echo -e "  ${YELLOW}○${NC} Grafana         未启动（或已跳过）"
  fi
  
  echo ""
  
  if [ "$DAEMON_MODE" = true ]; then
    echo -e "日志目录: $LOG_DIR"
    echo -e "PID 文件:"
    [ -f "$LOG_DIR/runtime.pid" ] && echo -e "  runtime: $(cat $LOG_DIR/runtime.pid)"
    [ -f "$LOG_DIR/studio.pid" ] && echo -e "  studio:  $(cat $LOG_DIR/studio.pid)"
    [ -f "$LOG_DIR/frontend.pid" ] && echo -e "  frontend: $(cat $LOG_DIR/frontend.pid)"
    echo ""
    echo -e "停止服务: ./scripts/stop-all.sh"
  else
    echo -e "按 Ctrl+C 停止所有服务"
  fi
  
  echo ""
}

# 主流程
main() {
  log_info "启动 Agent Studio 全栈服务..."
  echo ""
  
  start_monitoring
  # start_runtime — removed (runtime-proxy下线 2026-05-14)
  start_studio_backend
  start_frontend
  
  print_status
  
  if [ "$DAEMON_MODE" = true ]; then
    log_info "所有服务已在后台启动"
  else
    # 前台运行，等待所有后台任务
    wait
  fi
}

main