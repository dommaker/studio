/**
 * Runtime 事件回调（POST /api/v1/executions/events）——自 executions 模块迁入
 * （2026-10 架构精简刀1，docs/plans/2026-10-arch-simplification.md Phase 0-1）。
 * URL 路径与请求/响应形状不变，唯一调用方 = 同机 agent-runtime，零改动。
 *
 * 原 handler 的 executions.jsonl 状态同步与 data/tasks 任务同步未随迁：
 * 两者均为死写——executions.jsonl 读取方已全部清除（executions 模块整删 +
 * companies/pmo 越域深读斩除），data/tasks 目录 #181 起无读取方。
 * 活逻辑 = eventBus 'events' 频道发布（SSE /events/stream 等订阅方消费）。
 */

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { eventBus } from '@dommaker/studio-shared';
import { executionEventBodySchema, executionEventResponseSchema } from '@dommaker/studio-contract';
import { defineRoute } from '../../core/http.js';
import { requireRuntimeCallback } from '../../middleware/auth.js';
import { logger } from '@dommaker/studio-shared/node';

const router = Router();

// 接收外部事件：legacy 本机 runtime 走回环检查；SEC-05 sandbox Agent 走
// per-execution 服务身份（同 executionId 才接受），两条路径都不接受 Operator Session。
router.post('/events', requireRuntimeCallback(), defineRoute({ body: executionEventBodySchema, response: executionEventResponseSchema }, async (_req, _res, { body: event }) => {
  logger.info('Received runtime event', { event: JSON.stringify(event).substring(0, 100) });

  // 发布到 eventBus（SSE /events/stream 直订 'events' 频道，无需轮询）
  eventBus.publish('events', {
    event_id: event.executionId || uuidv4(),
    event_type: event.type || event.event_type || 'runtime.event',
    timestamp: event.timestamp || new Date().toISOString(),
    data: event,
  });

  return { received: true };
}));

export default router;
