/**
 * WorkUnit 事件发射测试
 *
 * 验证 create/claim/transitionStatus 正确发射事件。
 * 使用 eventBus mock 捕获事件。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eventBus } from '@dommaker/studio-shared';
import { WORKUNIT_EVENTS } from '../workunit-events.js';

// Mock eventBus
vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return {
    ...orig,
    eventBus: {
      publish: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    },
  };
});

describe('WorkUnit Events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('defines all event type constants', () => {
    expect(WORKUNIT_EVENTS.CREATED).toBe('workunit.created');
    expect(WORKUNIT_EVENTS.CLAIMED).toBe('workunit.claimed');
    expect(WORKUNIT_EVENTS.STATUS_CHANGED).toBe('workunit.status_changed');
    expect(WORKUNIT_EVENTS.DONE).toBe('workunit.done');
    expect(WORKUNIT_EVENTS.UNCLAIMED).toBe('workunit.unclaimed');
  });

  it('emitWorkUnitCreated publishes correct event', async () => {
    const { emitWorkUnitCreated } = await import('../workunit-events.js');

    emitWorkUnitCreated({
      workUnitId: 'wu-1',
      type: 'task',
      scope: 'test scope',
      channelId: 'ch-1',
    });

    expect(eventBus.publish).toHaveBeenCalledWith(WORKUNIT_EVENTS.CREATED, {
      workUnitId: 'wu-1',
      type: 'task',
      scope: 'test scope',
      channelId: 'ch-1',
    });
  });

  it('emitWorkUnitClaimed publishes correct event', async () => {
    const { emitWorkUnitClaimed } = await import('../workunit-events.js');

    emitWorkUnitClaimed({
      workUnitId: 'wu-1',
      agentId: 'agent-1',
      scope: 'test scope',
    });

    expect(eventBus.publish).toHaveBeenCalledWith(WORKUNIT_EVENTS.CLAIMED, {
      workUnitId: 'wu-1',
      agentId: 'agent-1',
      scope: 'test scope',
    });
  });

  it('emitWorkUnitStatusChanged publishes correct event', async () => {
    const { emitWorkUnitStatusChanged } = await import('../workunit-events.js');

    emitWorkUnitStatusChanged({
      workUnitId: 'wu-1',
      oldStatus: 'unassigned',
      newStatus: 'active',
    });

    expect(eventBus.publish).toHaveBeenCalledWith(WORKUNIT_EVENTS.STATUS_CHANGED, {
      workUnitId: 'wu-1',
      oldStatus: 'unassigned',
      newStatus: 'active',
    });
  });

  it('emitWorkUnitDone publishes correct event', async () => {
    const { emitWorkUnitDone } = await import('../workunit-events.js');

    emitWorkUnitDone({
      workUnitId: 'wu-1',
      scope: 'test scope',
    });

    expect(eventBus.publish).toHaveBeenCalledWith(WORKUNIT_EVENTS.DONE, {
      workUnitId: 'wu-1',
      scope: 'test scope',
    });
  });
});
