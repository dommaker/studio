/**
 * audit-logs 模块公共出口（P2-c 立界，scripts/p2c-public-surface.mjs 生成）
 *
 * 跨模块只允许 import 本文件（模块根）；深路径 import 由 eslint local/no-deep-module-import 拦截。
 * 公共面 = 生成时实际被模块外消费的符号；新增跨模块消费时在此补导出。
 */
export { recordAgentDecision } from './agent-decision.js';
export type { AuditActor } from './agent-decision.js';
// #684 包下沉：AuditService 自 packages/studio-audit 并入本模块，getAuditService 为进程级单例入口
export { AuditService, AuditActions, AuditResources, getAuditService } from './audit-service.js';
export type { AuditLogInput, AuditLogQuery, AuditLogStats } from './audit-service.js';
