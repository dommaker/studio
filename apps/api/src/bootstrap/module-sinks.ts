// ── 模块 sink 装配（Phase 5 SCC 第一刀，2026-10-16）──
// 依赖倒置：注册口在调用方模块（auth/audit-sink.ts），这里在装配期把
// 被调方（audit-logs）的实现注进去，消除 auth→audit-logs 模块级单边。
// 必须在首次业务调用（路由流量）前完成 → bootstrap() 里挂在 registerRoutes 之前；
// 新增 sink = 本文件加一行 + 调用方模块加注册口。
import { registerAuthAuditSink } from '../modules/auth/index.js';
import { getAuditService } from '../modules/audit-logs/index.js';

export function registerModuleSinks(): void {
  registerAuthAuditSink((entry) => getAuditService().log(entry));
}
