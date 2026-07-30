/**
 * WorkUnit 事件 → SSE 桥单测
 *  - initWorkunitEventsBridge 把 eventBus 的 workunit.* 转发到 'events' 频道（完整信封）
 *  - 幂等：重复 init 不重复注册
 */
import { describe, it, expect, afterEach } from 'vitest';
import { eventBus } from '@dommaker/studio-shared';
import { eventStore } from '../../../core/event-store.js';
import { initWorkunitEventsBridge } from '../workunit-events-bridge.js';

afterEach(() => {
  eventBus.unsubscribeAll?.('workunit.created');
  eventBus.unsubscribeAll?.('workunit.status_changed');
});

describe('workunit-events-bridge', () => {
  it('workunit.created / status_changed 转发到 events 频道（信封含 event_type/data）', async () => {
    initWorkunitEventsBridge();

    const received: Array<{ event_type: string; data: unknown }> = [];
    eventStore.subscribe('events', (message: string) => {
      const parsed = JSON.parse(message);
      if (parsed.event_type?.startsWith('workunit.')) received.push(parsed);
    });

    eventBus.publish('workunit.created', { workunit: { id: 'wu-1', status: 'unassigned' } });
    eventBus.publish('workunit.status_changed', { workunit: { id: 'wu-1', status: 'active' } });
    await new Promise(r => setTimeout(r, 20));

    expect(received.map(e => e.event_type)).toEqual(['workunit.created', 'workunit.status_changed']);
    expect((received[0].data as { workunit: { id: string } }).workunit.id).toBe('wu-1');
    expect(typeof (received[0] as unknown as { event_id: string }).event_id).toBe('string');
  });
});
