/**
 * WorkUnit 事件 → SSE 桥
 *
 * WorkUnitService 的生命周期事件（workunit.created / workunit.status_changed）
 * 发布在进程内 eventBus 上（订阅方：ReviewDispatcher、progress-rollup 等）。
 * 本桥把它们转发到 'events' 频道，经 /api/v1/events/stream 推给前端
 * （WU 列表/抽屉实时刷新，替代纯 REST 刷新）。
 * 信封形状与 channel-message.service.ts 的 publishSSE 一致。
 */

import { eventBus, logger } from '@dommaker/studio-shared';
import { v4 as uuidv4 } from 'uuid';
import { eventStore } from '../../core/event-store.js';

const FORWARDED_EVENTS = ['workunit.created', 'workunit.status_changed'] as const;

let started = false;

/** 幂等：重复调用不再注册（index.ts 启动时调用一次） */
export function initWorkunitEventsBridge(): void {
  if (started) return;
  started = true;

  for (const eventType of FORWARDED_EVENTS) {
    eventBus.subscribe(eventType, (payload: unknown) => {
      eventStore.publish('events', JSON.stringify({
        event_type: eventType,
        event_id: uuidv4(),
        timestamp: new Date().toISOString(),
        data: payload,
      })).catch(() => {}); // best-effort
    });
  }
  logger.info('[Events] WorkUnit events bridge subscribed', { events: FORWARDED_EVENTS });
}
