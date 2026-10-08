/**
 * agents 域契约——§10.5 token-usage 面（/api/v1/agents 下唯一活面）。
 * 正本以 token-usage.service.ts（AgentTokenUsage）实测 wire 为准。
 *
 * legacy CRUD 面（GET/POST/PUT/DELETE /api/v1/agents）已随 2026-10 架构精简刀2
 * 删除（LEGACY surface，web 消费方 #347 已清），对应 legacy* schema 同批退役。
 *
 * 端点（route-registry /api/v1/agents 单 entry）：
 *   GET /agents/:id/token-usage  profile 级 token 聚合（只读；空数据返回全零不抛错）
 *
 * wire 形状（defineRoute 统一壳后）：裸聚合 → `{ data: usage }`（无前端消费方）。
 */

import { z } from 'zod';
import { dataBodySchema } from './envelope.js';

// ── §10.5 token 聚合 ──

export const tokenUsageWindowSchema = z.object({
  injectedTokens: z.number(),
  executionTokens: z.number(),
  totalTokens: z.number(),
});
export type TokenUsageWindow = z.infer<typeof tokenUsageWindowSchema>;

/** profile 级 token 滚动视图（无前端消费方，z.infer 不手写） */
export const agentTokenUsageSchema = z.object({
  profileId: z.string(),
  totals: tokenUsageWindowSchema,
  /** 本地自然日（与 now 同一天） */
  today: tokenUsageWindowSchema,
  /** 滚动 7 天（now-7d ~ now） */
  rolling7d: tokenUsageWindowSchema,
  /** 有 token 事件归因到本 profile 的去重 WU 数 */
  workUnitCount: z.number(),
  trees: z.object({
    participated: z.number(),
    avgTreeDepth: z.number(),
  }),
  generatedAt: z.string(),
});
export type AgentTokenUsage = z.infer<typeof agentTokenUsageSchema>;

// ── 请求 ──

export const agentTokenUsageParamsSchema = z.object({ id: z.string().min(1) });

// ── 响应 ──

export const agentTokenUsageResponseSchema = dataBodySchema(agentTokenUsageSchema);
