// Audit Event Subscriber — EventBus 审计事件持久化到 KnowledgeStore (B0-002)
// #324：直订 eventBus（发布方 harness/hooks/audit.ts 本就直发对象 payload，无字符串壳）
import { eventBus, logger } from '@dommaker/studio-shared';

let started = false;

export function startAuditSubscriber(): void {
  if (started) return;

  eventBus.subscribe('events:audit', async (event: { entityType?: string; eventType?: string }) => {
    // eventBus 精确匹配走 EventEmitter.emit，handler 抛异常会向上抛——内部 try/catch 护住
    try {
      const { sharedStore } = await import('../knowledge/knowledge-singletons.js');
      const id = `audit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      sharedStore.save({
        id,
        type: 'guideline' as any,
        title: `${event.entityType}:${event.eventType}`.slice(0, 100),
        content: JSON.stringify(event),
        maturity: 'active' as any,
        layer: 'project',
        created: new Date().toISOString(),
        lastReferenced: new Date().toISOString(),
        contributors: ['audit-subscriber'],
        projects: [],
        tags: ['audit', event.entityType || 'unknown'],
        applicablePhases: [],
        sourceReferences: [],
        referencedBy: [],
        executionResults: [],
        consumptionMode: 'reference' as any,
        origin: 'system' as any,
      } as any);
    } catch (error) {
      logger.error('[AuditSubscriber] Failed to persist audit event', { error: String(error) });
    }
  });

  started = true;
  logger.info('[AuditSubscriber] Started');
}

export function stopAuditSubscriber(): void {
  started = false;
  logger.info('[AuditSubscriber] Stopped');
}
