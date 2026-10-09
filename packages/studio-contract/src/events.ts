/**
 * events 域契约——正本以 apps/api/src/modules/events/event.routes.ts 与
 * utils/studio-events.ts（@dommaker/studio-shared 写口）实测 wire 为准。
 *
 * 挂载（route-registry）：/api/v1/events 双挂——sseRoutes（SSE /stream，HZ-028）
 * 先于 eventRoutes（REST CRUD，G30/B9-014，auth）。**SSE /events/stream 事件流 payload
 * 契约在 ./sse-events.ts**（#665，ADR 2026-08-24 落地：事件词表 + payload 判别联合，
 * 前端本地解析器声明已清零），本文件只覆盖 REST 端点。
 *
 * wire 形状（defineRoute 统一壳后）：
 * - POST /            201 `{ data: { type, source, payload(string), createdAt } }`（原裸对象进壳）
 * - GET  /            `{ data: { events, total, nextCursor } }`（原平铺进壳；游标壳不变）
 * - POST /agent-events 201 `{ data: { ingested } }`（原平铺进壳）
 * - 错误统一 `{ error: { code, message } }`（原 `{ error: string }` / `{ error, details }`
 *   退役；手写 guard 文案变 zod 格式；500 文案由固定串变为实际错误消息，显式业务拒绝
 *   （空 payload / 写盘被拒）保留原文案）
 *
 * 另含 runtime 事件回调（POST /api/v1/executions/events → `{ data: { received: true } }`，
 * 自 executions 模块迁入 events 模块 runtime-events.routes.ts，URL/形状不变）。
 */

import { z } from 'zod';
import { dataBodySchema } from './envelope.js';

// ── 实体：StudioEvent 检索行（尾部倒读原样行，历史行字段稀疏）──

export const studioEventLevelSchema = z.enum(['debug', 'info', 'warning', 'critical']);
export type StudioEventLevel = z.infer<typeof studioEventLevelSchema>;

/** 检索行（前端 EventSearchPanel/NeedsAttentionSection 按必填消费 type）；
 * 历史行可能带 timestamp 等扩展键 → passthrough */
export const studioEventItemSchema = z.object({
  type: z.string(),
  source: z.string().optional(),
  level: studioEventLevelSchema.optional(),
  /** JSON 字符串（服务端落盘形态） */
  payload: z.string().optional(),
  createdAt: z.string().optional(),
}).passthrough();
export type StudioEventItem = z.infer<typeof studioEventItemSchema>;

// ── 派生读形状 ──

/** GET / 响应 data（total = 本页条数，nextCursor null = 没有更旧的） */
export const eventSearchResultSchema = z.object({
  events: z.array(studioEventItemSchema),
  total: z.number(),
  nextCursor: z.string().nullable(),
});
export type EventSearchResult = z.infer<typeof eventSearchResultSchema>;

/** POST / 201 响应 data（payload wire 恒为 string：对象 JSON.stringify、字符串原样） */
export const createStudioEventResultSchema = z.object({
  type: z.string(),
  source: z.string(),
  payload: z.string(),
  createdAt: z.string(),
});
export type CreateStudioEventResult = z.infer<typeof createStudioEventResultSchema>;

/** POST /agent-events 201 响应 data */
export const ingestAgentEventsResultSchema = z.object({
  ingested: z.number(),
});
export type IngestAgentEventsResult = z.infer<typeof ingestAgentEventsResultSchema>;

// ── 请求 ──

/** GET /（type/since/until/level/keyword/workUnitId 过滤 + 尾部倒读游标分页；
 * limit clamp 1-200 缺省 50、level 缺省 info 均在 handler） */
export const listStudioEventsQuerySchema = z.object({
  type: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  level: z.string().optional(),
  keyword: z.string().optional(),
  workUnitId: z.string().optional(),
  limit: z.string().optional(),
  cursor: z.string().optional(),
});
export type ListStudioEventsQuery = z.infer<typeof listStudioEventsQuerySchema>;

/** POST /（type/source 必填——原手写 400 收进 zod；payload 宽松 unknown，
 * D18 空 payload（缺失/{}/null/'{}'）拒绝在 handler 判，isEmptyEventPayload 唯一口径） */
export const createStudioEventBodySchema = z.object({
  type: z.string().min(1),
  source: z.string().min(1),
  payload: z.unknown().optional(),
});
export type CreateStudioEventBody = z.infer<typeof createStudioEventBodySchema>;

/** B9-014 Agent Event Protocol 单条（四字段必填——原逐条手写校验收进 zod，
 * 「Validation failed + details[]」聚合错误体随之退役为 zod 首错格式） */
export const agentEventSchema = z.object({
  sessionId: z.string().min(1),
  agentId: z.string().min(1),
  timestamp: z.number(),
  type: z.string().min(1),
  payload: z.unknown().optional(),
});
export type AgentEventWire = z.infer<typeof agentEventSchema>;

/** POST /agent-events（非空数组 + ≤500 上限——原手写 400 收进 zod） */
export const agentEventBatchBodySchema = z.array(agentEventSchema).min(1).max(500);
export type AgentEventBatchBody = z.infer<typeof agentEventBatchBodySchema>;

// ── 响应（统一 `{ data }` 壳）──

export const createStudioEventResponseSchema = dataBodySchema(createStudioEventResultSchema);
export const eventSearchResponseSchema = dataBodySchema(eventSearchResultSchema);
export const ingestAgentEventsResponseSchema = dataBodySchema(ingestAgentEventsResultSchema);

// ── runtime 事件回调（POST /api/v1/executions/events）──
// 自 executions.ts 迁入（2026-10 架构精简刀1：executions 模块整删，端点挪入 events 模块，
// URL 与 wire 形状不变）。唯一调用方 = 同机 agent-runtime（requireLocalhost），不解析响应体。

/**
 * runtime 事件体（agent-runtime 同机进程推送），字段全集归 runtime，
 * passthrough 放行；type/event_type/executionId/timestamp 均可选
 * （handler 自行容错，缺键按 'runtime.event' 兜底）。
 */
export const executionEventBodySchema = z.object({
  type: z.string().optional(),
  event_type: z.string().optional(),
  executionId: z.string().optional(),
  timestamp: z.string().optional(),
  workflow: z.unknown().optional(),
  outputs: z.unknown().optional(),
  error: z.unknown().optional(),
}).passthrough();
export type ExecutionEventBody = z.infer<typeof executionEventBodySchema>;

export const executionEventResultSchema = z.object({
  received: z.boolean(),
});
export type ExecutionEventResult = z.infer<typeof executionEventResultSchema>;

export const executionEventResponseSchema = dataBodySchema(executionEventResultSchema);
