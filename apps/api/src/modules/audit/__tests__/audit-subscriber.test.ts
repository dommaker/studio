// audit-subscriber 单测（#324）：直订 eventBus 的 events:audit，
// handler 收对象 payload（发布方 harness/hooks/audit.ts 本就直发对象），
// 以原形态持久化到 KnowledgeStore（sharedStore.save，content = 事件 JSON）。
import { describe, it, expect, afterAll, vi } from 'vitest';
import { eventBus } from '@dommaker/studio-shared';
import { startAuditSubscriber, stopAuditSubscriber } from '../audit-subscriber.js';
import { sharedStore } from '../../knowledge/knowledge-singletons.js';

describe('audit-subscriber', () => {
  afterAll(() => {
    stopAuditSubscriber();
    eventBus.unsubscribeAll('events:audit');
  });

  it('eventBus 直发对象到 events:audit → 原形态持久化', async () => {
    const saveSpy = vi.spyOn(sharedStore, 'save').mockImplementation(() => undefined as never);
    try {
      startAuditSubscriber();

      const event = {
        entityType: 'workunit',
        eventType: 'created',
        workUnitId: 'wu-audit-1',
        at: '2026-08-25T00:00:00Z',
      };
      eventBus.publish('events:audit', event);
      // handler 内 dynamic import knowledge-singletons，等一拍
      await new Promise(r => setTimeout(r, 50));

      expect(saveSpy).toHaveBeenCalledTimes(1);
      const saved = saveSpy.mock.calls[0][0] as Record<string, unknown>;
      expect(saved.content).toBe(JSON.stringify(event));
      expect(saved.title).toBe('workunit:created');
      expect(saved.tags).toEqual(expect.arrayContaining(['audit', 'workunit']));
    } finally {
      saveSpy.mockRestore();
    }
  });
});
