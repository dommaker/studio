/**
 * Audit Recorder 测试
 *
 * 文件写已停（#425 a1）：recordDecision 只发 EventBus，断言走订阅捕获。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { recordDecision, recordDecisions } from '../audit';
import { eventBus } from '../../../event-bus';

describe('AuditRecorder', () => {
  const received: unknown[] = [];
  const handler = (payload: unknown) => { received.push(payload); };

  afterEach(() => {
    eventBus.unsubscribe('events:audit', handler);
    received.length = 0;
  });

  it('recordDecision 发布 events:audit 事件（id/timestamp 统一加盖）', () => {
    eventBus.subscribe('events:audit', handler);

    recordDecision({
      eventType: 'test.event',
      entityType: 'test',
      entityId: 'test-1',
      summary: 'Test audit event',
      actorRole: 'executor',
    });

    const found = received.find(e => (e as { entityId: string }).entityId === 'test-1') as Record<string, unknown>;
    expect(found).toBeDefined();
    expect(found.eventType).toBe('test.event');
    expect(found.entityId).toBe('test-1');
    expect(found.summary).toBe('Test audit event');
    expect(found.actorRole).toBe('executor');
    expect(found.id).toBeDefined();
    expect(found.timestamp).toBeDefined();
  });

  it('recordDecisions 批量逐条发布', () => {
    eventBus.subscribe('events:audit', handler);

    recordDecisions([
      { eventType: 'batch.1', entityType: 'batch', entityId: 'b-1', summary: 'Batch 1' },
      { eventType: 'batch.2', entityType: 'batch', entityId: 'b-2', summary: 'Batch 2' },
      { eventType: 'batch.3', entityType: 'batch', entityId: 'b-3', summary: 'Batch 3' },
    ]);

    const batchEntries = received.filter(e => (e as { entityType: string }).entityType === 'batch');
    expect(batchEntries).toHaveLength(3);
    expect(batchEntries.map(e => (e as { summary: string }).summary)).toEqual(['Batch 1', 'Batch 2', 'Batch 3']);
  });

  it('不写 ~/.harness/audit/ 全局目录（#425 a1 停写）', () => {
    eventBus.subscribe('events:audit', handler);

    recordDecision({
      eventType: 'path.test', entityType: 'path', entityId: 'p-1', summary: 'Path test',
    });

    expect(received).toHaveLength(1); // 事件照发，仅无文件写
  });

  it('details 字段随事件透传', () => {
    eventBus.subscribe('events:audit', handler);

    recordDecision({
      eventType: 'detail.test',
      entityType: 'detail',
      entityId: 'd-1',
      summary: 'Detail test',
      details: { count: 5, stepCount: 3, tags: ['auth', 'jwt'] },
    });

    const found = received.find(e => (e as { entityId: string }).entityId === 'd-1') as Record<string, unknown>;
    expect(found.details).toEqual({ count: 5, stepCount: 3, tags: ['auth', 'jwt'] });
  });
});
