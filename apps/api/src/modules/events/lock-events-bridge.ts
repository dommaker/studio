/**
 * lock.* 事件 → Monitor 告警桥（#169 / #64 决议 4）
 *
 * FileStore.withLock 的 stale 回收（lock.stale_reclaimed）与获锁超时
 * （lock.acquire_timeout）发布在进程内 eventBus 上——studio-shared 是纯包，
 * 不能依赖 apps/api，故由本桥转发。
 * 每个事件做两件事：
 *   1. emitMonitorEvent：结构化字段（lockDir / owner pid / acquiredAt / 判据 /
 *      回收者 pid / 等待时长）原样落统一事件流（studio-events.jsonl）；
 *   2. dispatchMonitorAlerts：告警全管线（logger + monitor:alert 事件 + notifyAlert
 *      通知出口）。两事件均 warning 级，不设 critical（#64 决议 4）。
 */

import { eventBus, logger } from '@dommaker/studio-shared';
import { dispatchMonitorAlerts, emitMonitorEvent } from '../agents/monitor/monitor-alerts.js';

const FORWARDED_EVENTS = ['lock.stale_reclaimed', 'lock.acquire_timeout'] as const;

let started = false;

/** 幂等：重复调用不再注册（index.ts 启动时调用一次） */
export function initLockEventsBridge(): void {
  if (started) return;
  started = true;

  for (const eventType of FORWARDED_EVENTS) {
    eventBus.subscribe(eventType, (payload: unknown) => {
      const data = (payload ?? {}) as Record<string, unknown>;
      try {
        emitMonitorEvent({ type: eventType, ...data });
      } catch { /* non-blocking */ }
      dispatchMonitorAlerts([{
        level: 'warning',
        source: 'lock',
        message: `[FileStore] ${eventType} ${JSON.stringify(data)}`,
      }]);
    });
  }
  logger.info('[Events] Lock events bridge subscribed', { events: FORWARDED_EVENTS });
}
