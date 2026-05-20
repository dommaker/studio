// Audit Event Subscriber — EventBus 审计事件持久化到 DB (B0-002)
import { eventStore } from '../../core/event-store.js';
import { prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';

let started = false;

export function startAuditSubscriber(): void {
  if (started) return;

  eventStore.subscribe('events:audit', async (message: string) => {
    try {
      const event = JSON.parse(message);
      await prisma.decisionAudit.create({
        data: {
          eventType: event.eventType || 'unknown',
          entityType: event.entityType || 'unknown',
          entityId: event.entityId || event.id || 'unknown',
          companyId: event.companyId || null,
          projectId: event.projectId || null,
          summary: event.summary || '',
          details: event.details || null,
          actorRole: event.actorRole || null,
        },
      });
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
