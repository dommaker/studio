/**
 * WorkUnit 事件 → SSE 桥
 *
 * WorkUnitService 的生命周期事件（workunit.created / workunit.status_changed）
 * 发布在进程内 eventBus 上（订阅方：ReviewDispatcher、progress-rollup 等）。
 * 本桥把它们转发到 'events' 频道，经 /api/v1/events/stream 推给前端
 * （WU 列表/抽屉实时刷新，替代纯 REST 刷新）。
 * 信封形状与 channel-message.service.ts 的 publishSSE 一致。
 */

import { eventBus } from '@dommaker/studio-shared';
import { v4 as uuidv4 } from 'uuid';
// #665（ADR 2026-08-24 落地）：转发词表 = studio-contract SSE 事件词表的子集；
// 负载形状（{ workunit } / { id, channelId } / { requirement }）契约同源，
// wire parity 见 ./__tests__/sse-payload-contract.test.ts。
import type { SseEventType } from '@dommaker/studio-contract';
import { logger } from '@dommaker/studio-shared/node';

const FORWARDED_EVENTS = [
  'workunit.created', 'workunit.status_changed',
  // #538（ADR 2026-09-15 决策 5）：GC/TTL 删除出声——负载 { id, channelId }，前端两 store 删行
  'workunit:removed',
  // SSE 负载加深（2026-08-24 计划）：REQ chips 改 SSE 驱动，负载 = { requirement }（含 id/title/status/channelId）
  'requirement.created', 'requirement.updated',
] as const satisfies readonly SseEventType[];

let started = false;

/** 幂等：重复调用不再注册（index.ts 启动时调用一次） */
export function initWorkunitEventsBridge(): void {
  if (started) return;
  started = true;

  for (const eventType of FORWARDED_EVENTS) {
    eventBus.subscribe(eventType, (payload: unknown) => {
      eventBus.publish('events', {
        event_type: eventType,
        event_id: uuidv4(),
        timestamp: new Date().toISOString(),
        data: payload,
      });
    });
  }
  logger.info('[Events] WorkUnit events bridge subscribed', { events: FORWARDED_EVENTS });
}
