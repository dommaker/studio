/**
 * WorkUnit 事件 → SSE 桥单测
 *  - initWorkunitEventsBridge 把 eventBus 的 workunit.* / requirement.* 转发到 'events' 频道（完整信封）
 *  - 幂等：重复 init 不重复注册
 */
import { describe, it, expect } from 'vitest';
import { eventBus } from '@dommaker/studio-shared';
import { initWorkunitEventsBridge } from '../workunit-events-bridge.js';

// 桥内 started 幂等标志是模块态：同文件后续用例的 init() 为 no-op，
// 订阅靠首个用例的 init 持续生效（vitest 文件间隔离，不做 afterEach 反注册——反注册会让后续用例收不到事件）。

describe('workunit-events-bridge', () => {
  it('workunit.created / status_changed 转发到 events 频道（信封含 event_type/data）', async () => {
    initWorkunitEventsBridge();

    const received: Array<{ event_type: string; data: unknown }> = [];
    eventBus.subscribe('events', (envelope: { event_type?: string; data: unknown }) => {
      if (envelope.event_type?.startsWith('workunit.')) received.push(envelope as (typeof received)[number]);
    });

    eventBus.publish('workunit.created', { workunit: { id: 'wu-1', status: 'unassigned' } });
    eventBus.publish('workunit.status_changed', { workunit: { id: 'wu-1', status: 'active' } });
    await new Promise(r => setTimeout(r, 20));

    expect(received.map(e => e.event_type)).toEqual(['workunit.created', 'workunit.status_changed']);
    expect((received[0].data as { workunit: { id: string } }).workunit.id).toBe('wu-1');
    expect(typeof (received[0] as unknown as { event_id: string }).event_id).toBe('string');
  });

  it('requirement.created / updated 转发到 events 频道（data.requirement 含 id/channelId/title/status）', async () => {
    initWorkunitEventsBridge(); // 幂等 no-op（首个用例已注册），订阅仍生效

    const received: Array<{ event_type: string; data: { requirement: Record<string, unknown> } }> = [];
    eventBus.subscribe('events', (envelope: { event_type?: string; data: { requirement: Record<string, unknown> } }) => {
      if (envelope.event_type?.startsWith('requirement.')) received.push(envelope as (typeof received)[number]);
    });

    const requirement = { id: 'REQ-0007', seq: 7, title: '加个功能', status: 'open', channelId: 'ch-1', createdAt: 'x', createdBy: 'manual' };
    eventBus.publish('requirement.created', { requirement });
    eventBus.publish('requirement.updated', { requirement: { ...requirement, status: 'done' } });
    await new Promise(r => setTimeout(r, 20));

    expect(received.map(e => e.event_type)).toEqual(['requirement.created', 'requirement.updated']);
    expect(received[0].data.requirement).toMatchObject({ id: 'REQ-0007', channelId: 'ch-1', title: '加个功能', status: 'open' });
    expect(received[1].data.requirement.status).toBe('done');
  });
});
