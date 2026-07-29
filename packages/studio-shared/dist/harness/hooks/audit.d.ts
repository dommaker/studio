/**
 * Audit Recorder — 决策级审计事件记录
 *
 * L1: recordDecision() 写入 ~/.harness/audit/{date}.jsonl（追加不可变）
 *     + 发布 EventBus 事件，由 API 层异步写入 DB DecisionAudit 表
 * L2/L3 由 Auditor 角色消费。
 */
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
 * 写入审计文件 + 发布 EventBus 事件供 DB 持久化
 */
export declare function recordDecision(event: AuditEvent): void;
export declare function recordDecisions(events: AuditEvent[]): void;
//# sourceMappingURL=audit.d.ts.map