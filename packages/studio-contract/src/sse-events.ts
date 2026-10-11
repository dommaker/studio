/**
 * SSE 事件负载契约（#665，ADR 2026-08-24 D1/D2 落地）——/api/v1/events/stream
 * 事件流的事件词表 + payload 判别联合，前后端同源唯一正本。
 *
 * 正本口径 = apps/api 各发射点（eventBus 'events' 频道）实测 wire 形态：
 * - 信封：{ event_id?, event_type, timestamp, data }——sse.routes 原样转发；
 *   event_id 可缺省（knowledge.entry_changed / knowledge 桥发射点不带）。
 * - 两个 wire 特例（历史包袱，如实记录不改形状——ADR D2 additive 纪律）：
 *   1. connection.established 是裸帧：sse.routes 连接帧直发 { clientId, topics }，
 *      无信封、无 event_type（前端 onmessage 按 event_type 分发，天然忽略它）；
 *   2. knowledge 桥（knowledge-service.routes.ts initKnowledgeEventBridge）转发
 *      knowledge.<type> 用 `payload` 键而非 `data`——loose 信封 sseEnvelopeSchema 容忍，
 *      判别联合只收编词表内事件（词表外 = runtime.* 遗留 / knowledge 桥转发等，走 loose）。
 * - workunit:removed 是冒号命名（与 workunit.* 点号词族不一致，词表如实记录）。
 *
 * wire 形态 = 发射点产物 JSON 序列化后（Date → ISO string）：workunit 快照的
 * timeoutAt/createdAt 等在进程内是 Date，wire 上恒为 string，schema 按 wire 记。
 *
 * 消费方式：
 * - 后端发射点：import type 取 payload 类型构造负载（类型同源，编译期防漂移）；
 * - 前端：SseEventEnvelope 作信封类型（替代原本地 WebSocketMessage），payload 类型
 *   替代 types/workunit.ts 与 stores 里的本地声明；
 * - 运行时校验：sseEventSchema（判别联合，词表内严格）/ sseEnvelopeSchema（loose 兜底）。
 */

import { z } from 'zod';
import { workUnitSchema } from './workunit.js';
import { channelMessageSchema } from './channels.js';
import { requirementSchema } from './requirements.js';
import { agentCurrentWorkUnitSchema, agentPmoSummarySchema } from './monitoring.js';

// ── channel 事件负载 ──

/** channel.message_sent：shapeMessageData 产物全量本体（meta 已解析为 object，wire 上 createdAt 为 ISO string） */
export const channelMessageSentPayloadSchema = z.object({
  channelId: z.string(),
  message: channelMessageSchema,
});
export type ChannelMessageSentPayload = z.infer<typeof channelMessageSentPayloadSchema>;

/**
 * channel.message_updated：messageId + 全量 message 必有（#311 起三发射点同口径）；
 * content/meta/workUnitId 为 additive 增量字段，按发射点缺省（合并后全量真值读 message）。
 */
export const channelMessageUpdatedPayloadSchema = z.object({
  channelId: z.string(),
  messageId: z.string(),
  content: z.string().optional(),
  meta: z.record(z.unknown()).optional(),
  workUnitId: z.string().nullable().optional(),
  message: channelMessageSchema,
});
export type ChannelMessageUpdatedPayload = z.infer<typeof channelMessageUpdatedPayloadSchema>;

// ── workunit / requirement 桥事件负载（workunit-events-bridge 转发进程内事件）──

/** workunit.created / workunit.status_changed：{ workunit } 全量快照（snapshotToData wire 形态 + #318 claimable） */
export const workunitEventPayloadSchema = z.object({
  workunit: workUnitSchema,
});
export type WorkunitEventPayload = z.infer<typeof workunitEventPayloadSchema>;

/** workunit:removed（#538 删除出声）：{ id, channelId }，前端两 store 据以删行 */
export const workunitRemovedPayloadSchema = z.object({
  id: z.string(),
  channelId: z.string().nullable(),
});
export type WorkunitRemovedPayload = z.infer<typeof workunitRemovedPayloadSchema>;

/** requirement.created / requirement.updated：{ requirement } 信封全量（与 REST get 同源，含 B3a projectId） */
export const requirementEventPayloadSchema = z.object({
  requirement: requirementSchema,
});
export type RequirementEventPayload = z.infer<typeof requirementEventPayloadSchema>;

// ── agent-loop 执行事件负载 ──

export const executionStepToolCallSchema = z.object({
  tool: z.string(),
  /** 面向人读的输入摘要（file_path / command / pattern…，已截断） */
  summary: z.string(),
});
export type ExecutionStepToolCall = z.infer<typeof executionStepToolCallSchema>;

/** workunit.execution.step（Layer A 步级事件；同 payload 落盘 workunit:execution_step 供 REST 回放） */
export const executionStepEventSchema = z.object({
  workUnitId: z.string(),
  executionId: z.string(),
  /** 来源频道（前端按频道过滤；无频道 WU 缺省） */
  channelId: z.string().nullable().optional(),
  sessionId: z.string().optional(),
  /** #639: 本步 CLI 真实会话号 */
  cliSessionId: z.string().optional(),
  /** #94: 本步会话续用(true)/新建(false) 标记 */
  sessionResumed: z.boolean().optional(),
  /** 1 基步号 */
  step: z.number(),
  action: z.string().optional(),
  /** #172: 本步成败（失败步携带 errorType/errorDetail） */
  status: z.enum(['success', 'failed']),
  errorType: z.string().optional(),
  errorDetail: z.string().optional(),
  thinking: z.array(z.string()),
  toolCalls: z.array(executionStepToolCallSchema),
  skills: z.array(z.string()),
  text: z.string().optional(),
  usage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    model: z.string().optional(),
  }).optional(),
  at: z.string(),
});
export type ExecutionStepEvent = z.infer<typeof executionStepEventSchema>;

export const executionStreamChunkKindSchema = z.enum(['step-start', 'thinking', 'text', 'tool', 'tool-result', 'result']);
export type ExecutionStreamChunkKind = z.infer<typeof executionStreamChunkKindSchema>;

/** workunit.execution.stream（Layer B 步内流式 chunk，SSE-only 无 REST 回放） */
export const executionStreamChunkSchema = z.object({
  workUnitId: z.string(),
  executionId: z.string(),
  /** 来源频道（前端按频道过滤；无频道 WU 缺省） */
  channelId: z.string().nullable().optional(),
  /** 1 基步号（与 Layer A 同口径） */
  step: z.number(),
  kind: executionStreamChunkKindSchema,
  text: z.string().optional(),
  tool: z.string().optional(),
  summary: z.string().optional(),
  /** #240: tool/tool-result 配对锚点（tool_use.id ↔ tool_result.tool_use_id） */
  toolUseId: z.string().optional(),
  isError: z.boolean().optional(),
  at: z.string(),
});
export type ExecutionStreamChunk = z.infer<typeof executionStreamChunkSchema>;

/**
 * workunit.tokens（M2 成本红线度量；同 payload 落盘 workunit:tokens）。
 * executionTokens 为 null = CLI 未回报 usage（不编造 0）；usage 明细段 additive 可缺省。
 */
export const workunitTokenEventSchema = z.object({
  workUnitId: z.string(),
  executionId: z.string().optional(),
  /** 注入上下文估算 tokens（estimateTokens 口径） */
  injectedTokens: z.number(),
  injectedSource: z.string().optional(),
  /** 执行总 tokens；CLI 未回报 usage 时为 null */
  executionTokens: z.number().nullable(),
  executionSource: z.string().optional(),
  totalTokens: z.number(),
  extractionTokens: z.number().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  cacheCreationTokens: z.number().optional(),
  billedTokens: z.number().optional(),
  costUsd: z.number().optional(),
  numTurns: z.number().optional(),
  triggerId: z.string().optional(),
  provider: z.string().optional(),
  channelId: z.string().optional(),
});
export type WorkunitTokenEvent = z.infer<typeof workunitTokenEventSchema>;

// ── agent / notification / knowledge 事件负载 ──

/**
 * agent.instance.status_changed（#312/#318 additive 定型）：
 * profileId/name/status + 可空快照段（currentWorkUnit/pmo/channelId/lastError*）。
 * instanceId 可空 = recordStartupFailure 的 error 迁移（状态落盘失败时无实例 id）。
 */
export const agentInstanceStatusChangedPayloadSchema = z.object({
  profileId: z.string(),
  instanceId: z.string().nullable(),
  name: z.string(),
  status: z.string(),
  currentWorkUnitId: z.string().nullable(),
  currentWorkUnit: agentCurrentWorkUnitSchema.nullable(),
  channelId: z.string().nullable(),
  pmo: agentPmoSummarySchema.nullable(),
  startedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  lastErrorAt: z.string().nullable(),
});
export type AgentInstanceStatusChangedPayload = z.infer<typeof agentInstanceStatusChangedPayloadSchema>;

/** agent.health.failed：启动失败告警（与 status_changed error 迁移并存，additive 不动） */
export const agentHealthFailedPayloadSchema = z.object({
  profileId: z.string(),
  name: z.string(),
  provider: z.string(),
  error: z.string(),
});
export type AgentHealthFailedPayload = z.infer<typeof agentHealthFailedPayloadSchema>;

/** notification.created（gate-escalation tier1 铃铛即时失效 + 浏览器原生通知） */
export const notificationCreatedPayloadSchema = z.object({
  title: z.string(),
  content: z.string(),
  wuId: z.string(),
  link: z.string(),
});
export type NotificationCreatedPayload = z.infer<typeof notificationCreatedPayloadSchema>;

/** knowledge.entry_changed：轻量元信息（消费方当「重拉信号」用，不做就地拼接） */
export const knowledgeEntryChangedPayloadSchema = z.object({
  action: z.enum(['created', 'promoted', 'demoted']),
  entryId: z.string().optional(),
  entryType: z.string().optional(),
  title: z.string().optional(),
});
export type KnowledgeEntryChangedPayload = z.infer<typeof knowledgeEntryChangedPayloadSchema>;

// ── 事件词表 + 判别联合 ──

/**
 * workunit.execution.stream 的 event_type 字面量（#687：常量自 agent-loop 上移本契约，
 * 发射点 agent-loop 与消费方 events/sse.routes 同源，斩断 events → agent-loop 反向依赖）。
 */
export const EXECUTION_STREAM_SSE_TYPE = 'workunit.execution.stream' as const;

/** SSE 事件词表（判别联合收编范围；词表外事件走 sseEnvelopeSchema loose 兜底） */
export const SSE_EVENT_TYPES = [
  'channel.message_sent',
  'channel.message_updated',
  'workunit.created',
  'workunit.status_changed',
  'workunit:removed',
  'workunit.execution.step',
  'workunit.execution.stream',
  'workunit.tokens',
  'requirement.created',
  'requirement.updated',
  'agent.instance.status_changed',
  'agent.health.failed',
  'notification.created',
  'knowledge.entry_changed',
] as const;
export type SseEventType = (typeof SSE_EVENT_TYPES)[number];

/** event_type → payload 类型映射（后端发射点类型同源的取类型入口） */
export interface SseEventPayloadMap {
  'channel.message_sent': ChannelMessageSentPayload;
  'channel.message_updated': ChannelMessageUpdatedPayload;
  'workunit.created': WorkunitEventPayload;
  'workunit.status_changed': WorkunitEventPayload;
  'workunit:removed': WorkunitRemovedPayload;
  'workunit.execution.step': ExecutionStepEvent;
  'workunit.execution.stream': ExecutionStreamChunk;
  'workunit.tokens': WorkunitTokenEvent;
  'requirement.created': RequirementEventPayload;
  'requirement.updated': RequirementEventPayload;
  'agent.instance.status_changed': AgentInstanceStatusChangedPayload;
  'agent.health.failed': AgentHealthFailedPayload;
  'notification.created': NotificationCreatedPayload;
  'knowledge.entry_changed': KnowledgeEntryChangedPayload;
}

const envelopeFields = {
  /** knowledge.entry_changed / knowledge 桥发射点不带 event_id */
  event_id: z.string().optional(),
  timestamp: z.string(),
};

/** SSE 事件判别联合（wire 校验入口；按 event_type narrow 到具名 payload 类型） */
export const sseEventSchema = z.discriminatedUnion('event_type', [
  z.object({ ...envelopeFields, event_type: z.literal('channel.message_sent'), data: channelMessageSentPayloadSchema }),
  z.object({ ...envelopeFields, event_type: z.literal('channel.message_updated'), data: channelMessageUpdatedPayloadSchema }),
  z.object({ ...envelopeFields, event_type: z.literal('workunit.created'), data: workunitEventPayloadSchema }),
  z.object({ ...envelopeFields, event_type: z.literal('workunit.status_changed'), data: workunitEventPayloadSchema }),
  z.object({ ...envelopeFields, event_type: z.literal('workunit:removed'), data: workunitRemovedPayloadSchema }),
  z.object({ ...envelopeFields, event_type: z.literal('workunit.execution.step'), data: executionStepEventSchema }),
  z.object({ ...envelopeFields, event_type: z.literal('workunit.execution.stream'), data: executionStreamChunkSchema }),
  z.object({ ...envelopeFields, event_type: z.literal('workunit.tokens'), data: workunitTokenEventSchema }),
  z.object({ ...envelopeFields, event_type: z.literal('requirement.created'), data: requirementEventPayloadSchema }),
  z.object({ ...envelopeFields, event_type: z.literal('requirement.updated'), data: requirementEventPayloadSchema }),
  z.object({ ...envelopeFields, event_type: z.literal('agent.instance.status_changed'), data: agentInstanceStatusChangedPayloadSchema }),
  z.object({ ...envelopeFields, event_type: z.literal('agent.health.failed'), data: agentHealthFailedPayloadSchema }),
  z.object({ ...envelopeFields, event_type: z.literal('notification.created'), data: notificationCreatedPayloadSchema }),
  z.object({ ...envelopeFields, event_type: z.literal('knowledge.entry_changed'), data: knowledgeEntryChangedPayloadSchema }),
]);
export type SseEvent = z.infer<typeof sseEventSchema>;

/**
 * loose 信封（前端 onmessage 解析入口；词表外事件——runtime.* 遗留、
 * knowledge 桥 `payload` 键转发、task.* 等——原样透传，形状断言归消费点）。
 */
export const sseEnvelopeSchema = z.object({
  event_id: z.string().optional(),
  event_type: z.string(),
  timestamp: z.string().optional(),
  data: z.unknown().optional(),
  /** knowledge 桥历史包袱：knowledge.<type> 转发用 payload 键而非 data */
  payload: z.unknown().optional(),
}).passthrough();
export type SseEventEnvelope = z.infer<typeof sseEnvelopeSchema>;

/** connection.established 裸帧（sse.routes 连接帧直发，无信封无 event_type） */
export const connectionEstablishedFrameSchema = z.object({
  clientId: z.string(),
  topics: z.array(z.string()),
});
export type ConnectionEstablishedFrame = z.infer<typeof connectionEstablishedFrameSchema>;
