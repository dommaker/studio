/**
 * executions 域契约（批次 7/8）——LEGACY surface，正本以
 * apps/api/src/modules/executions/routes.ts 实测 wire 为准。
 * 计划迁移到 agent-profiles / workunit API（docs/vision-2026.md），迁移前不扩展。
 *
 * 端点（route-registry /api/v1/executions）：
 *   GET  /                执行列表（分页 + status 过滤 + 进度计算）
 *   POST /events          外部 runtime 事件回调（requireLocalhost，同机 agent-runtime）
 *   GET  /:executionId    执行详情（含进度）
 *
 * wire 形状（defineRoute 统一壳后）：
 * - GET / 原 `{ data: [...], pagination }` ≡ paginated 分页壳，形状不变
 * - GET /:executionId 裸实体 → `{ data: execution }`（原 web executionApi 消费方
 *   已不存在——前端 grep 实证无 /api/v1/executions 调用，routes.ts 头注漂移同批修正）
 * - POST /events `{ received: true }` → `{ data: { received: true } }`
 *   （唯一调用方是同机 agent-runtime，不解析响应体）
 * - 500 code 'INTERNAL_ERROR' 归一为 INTERNAL；message 由固定串变为实际错误消息
 */

import { z } from 'zod';
import { dataBodySchema, paginatedBodySchema } from './envelope.js';

/**
 * 执行行（executions.jsonl 历史行稀疏，passthrough 放行扩展键）+
 * 路由层进度三键（currentStep/totalSteps/progress 由 nodeExecutions 派生）。
 */
export const executionWithProgressSchema = z.object({
  currentStep: z.number(),
  totalSteps: z.number(),
  progress: z.number(),
}).passthrough();
export type ExecutionWithProgress = z.infer<typeof executionWithProgressSchema>;

/** GET /：page/limit 原样为字符串（handler parseInt），status 自由串过滤 */
export const executionListQuerySchema = z.object({
  status: z.string().optional(),
  page: z.string().optional(),
  limit: z.string().optional(),
});
export type ExecutionListQuery = z.infer<typeof executionListQuerySchema>;

export const executionDetailParamsSchema = z.object({ executionId: z.string().min(1) });

/**
 * POST /events：runtime 事件体（agent-runtime 同机进程推送），字段全集归 runtime，
 * passthrough 放行；type/event_type/executionId/workflow/outputs/error/timestamp 均可选
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

// ── 响应 ──

/** GET / → 分页壳 `{ data: [...], pagination }`（形状不变） */
export const executionListResponseSchema = paginatedBodySchema(executionWithProgressSchema);
export const executionGetResponseSchema = dataBodySchema(executionWithProgressSchema);
export const executionEventResponseSchema = dataBodySchema(executionEventResultSchema);
