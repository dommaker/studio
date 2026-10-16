/**
 * auth 审计出口缝（SEC-010；2026-10-16 Phase 5 SCC 第一刀 #1：消除 auth→audit-logs 模块边）。
 *
 * 依赖倒置：AuthAuditSink 接口与注册口在调用方（auth 本模块），bootstrap 装配期
 * （bootstrap/module-sinks.ts registerModuleSinks）把 audit-logs 的 AuditService.log
 * 注进来；auth 不再 import audit-logs。
 *
 * 未注册语义：warn 一次 + 丢弃（no-op resolve）。审计写盘失败在 routes.ts 本就降级为
 * logger.error 不阻断请求，注册缺失同属装配错误，按同级口径处理。
 */
import { logger } from '@dommaker/studio-shared/node';

/** auth 路由实际消费的审计字段（audit-logs AuditLogInput 的结构子集，字段契约随其保持一致） */
export interface AuthAuditEntry {
  userId?: string;
  sessionId?: string;
  ipAddress?: string;
  userAgent?: string;
  action: string;
  resource: string;
  resourceId?: string;
  details?: Record<string, unknown>;
  status?: 'success' | 'failure';
  errorMessage?: string;
}

export type AuthAuditSink = (entry: AuthAuditEntry) => Promise<unknown>;

let sink: AuthAuditSink | null = null;
let warned = false;

/** 装配期注入实现；测试可传 null 复位到未注册态 */
export function registerAuthAuditSink(fn: AuthAuditSink | null): void {
  sink = fn;
  warned = false;
}

/** routes.ts 调用入口；未注册时 warn 一次后静默丢弃 */
export function logAuthAudit(entry: AuthAuditEntry): Promise<unknown> {
  if (!sink) {
    if (!warned) {
      warned = true;
      logger.warn('[auth] AuthAuditSink 未注册（bootstrap 装配期应注入 audit-logs 实现），审计记录丢弃');
    }
    return Promise.resolve();
  }
  return sink(entry);
}
