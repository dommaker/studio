/**
 * ops 模块公共出口（#683：monitoring + agent-monitor + agent-ops + src/monitoring 四面合一）
 *
 * 跨模块只允许 import 本文件（模块根）；深路径 import 由 eslint local/no-deep-module-import 拦截。
 * 公共面 = 合并时实际被模块外消费的符号；新增跨模块消费时在此补导出。
 */
export { getMetrics } from './prometheus-metrics.js';
export { loadCurrentWuContexts } from './current-wu-context.js';
export type { CurrentWuContext } from './current-wu-context.js';
export { scanStaleAgentInstances } from './instance-timeout-scan.js';
export { initLockEventsBridge } from './lock-events-bridge.js';
export { dispatchMonitorAlerts, emitMonitorEvent } from './monitor-alerts.js';
export { getMonitorService } from './monitor.service.js';
export type { MonitorAlert, MonitorAlertSource } from './types.js';
export { createOpsService } from './ops.service.js';
