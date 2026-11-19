/**
 * auth 模块公共出口（P2-c 立界，scripts/p2c-public-surface.mjs 生成）
 *
 * 跨模块只允许 import 本文件（模块根）；深路径 import 由 eslint local/no-deep-module-import 拦截。
 * 公共面 = 生成时实际被模块外消费的符号；新增跨模块消费时在此补导出。
 */
export { hashPassword, verifyToken } from './service.js';
export type { SessionData, UserData } from './service.js';
// Phase 5 SCC 第一刀 #1：审计出口缝（SEC-010）。接口与注册口在调用方，bootstrap 装配期注入 audit-logs 实现
export { logAuthAudit, registerAuthAuditSink } from './audit-sink.js';
export type { AuthAuditEntry, AuthAuditSink } from './audit-sink.js';
