/**
 * Audit Recorder — 决策级审计事件记录
 *
 * recordDecision() 发布 EventBus 事件，由 API 层异步写入 DB DecisionAudit 表
 * （L1 全局文件 ~/.harness/audit/ 已停写——无活跃读方，#425 a1；L2/L3 由 Auditor 角色消费）。
 */

import { eventBus } from '../event-bus';

export interface AuditEvent {
  eventType: string;
  entityType: string;
  entityId: string;
  companyId?: string;
  projectId?: string;
  summary: string;
  details?: Record<string, unknown>;
  actorRole?: string;
}

/**
 * 发布审计事件供 DB 持久化（id/timestamp 在此统一加盖）
 */
export function recordDecision(event: AuditEvent): void {
  const entry = {
    ...event,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
  };

  // EventBus 事件（异步，DB 持久化由 API 层 audit-subscriber 处理）
  eventBus.publish('events:audit', entry);
}

export function recordDecisions(events: AuditEvent[]): void {
  for (const event of events) {
    recordDecision(event);
  }
}
