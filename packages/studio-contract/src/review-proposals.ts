/**
 * review-proposal 域契约——正本以 apps/api/src/modules/review-proposal/
 * routes.ts（实测 wire）、service.ts（生命周期结果）、store.ts（状态词表）为准。
 *
 * 通用提案端点（kind 走注册表分发：distill/gc/audit/memory/knowledge/auditor/
 * constraint/evolution/decision-audit 等）：
 *   POST /api/v1/review-proposals/:kind/:id/approve → adapter.onApprove
 *   POST /api/v1/review-proposals/:kind/:id/reject  → 落 rejected 墓碑 + adapter.onReject
 *   GET  /api/v1/review-proposals/:kind/:id/status  → 提案状态（只读）
 *
 * wire 形状（defineRoute 统一壳后）：
 * - approve：executed → `{ data: { success: true, ...adapterData } }`（adapter data
 *   原样透传，per-kind 扩展字段如 productIds/archivedIds/promoted/workUnitId）；
 *   skipped（预算熔断，非错误）200 → `{ data: { success: false, skipped } }`
 * - reject：`{ data: { success: true } }`
 * - status：`{ data: { status } }`（原 `{ success: true, status }` 的 success 标志退役）
 * - 错误统一 `{ error: { code, message } }`（原 `{ error: string }`）：
 *   unknown-kind → 404 NOT_FOUND；proposal-not-found / proposal-not-pending:<status>
 *   → 400 BAD_REQUEST（message 保留原机器串，前端 notPendingAs 按 message 分类）；
 *   执行失败 failed / 前置不可用 aborted → 500 INTERNAL
 */

import { z } from 'zod';
import { dataBodySchema } from './envelope.js';

/**
 * 提案状态词表（store.ts 唯一口径）：pending | executed | rejected | failed |
 * card-failed；+ stale（#623 evolution 读侧归一：pending/approved 超期未审惰性转
 * stale，墓碑写路径不产生）。role-memory 旧 promoted 墓碑读取时归一为 executed
 * （ADR 决策 3，存量历史行不改写）。
 */
export const reviewProposalStatusSchema = z.enum([
  'pending', 'executed', 'rejected', 'failed', 'card-failed', 'stale',
]);
export type ReviewProposalStatus = z.infer<typeof reviewProposalStatusSchema>;

/** GET status 的 status 值域：正本词表 + unknown（查无此提案） */
export const reviewProposalStatusValueSchema = z.enum([
  'pending', 'executed', 'rejected', 'failed', 'card-failed', 'stale', 'unknown',
]);
export type ReviewProposalStatusValue = z.infer<typeof reviewProposalStatusValueSchema>;

// ── 请求：params ──

/** /:kind/:id/{approve,reject,status} 共用 params */
export const reviewProposalParamsSchema = z.object({
  kind: z.string().min(1),
  id: z.string().min(1),
});
export type ReviewProposalParams = z.infer<typeof reviewProposalParamsSchema>;

// ── 响应 ──

/**
 * approve 响应 data：executed → success:true + adapter data 透传（per-kind 扩展：
 * distill productIds / gc archivedIds / memory promoted+topicsUpdated / auditor
 * workUnitId / knowledge promoted / constraint constraintId+committed / evolution
 * proposalId+appliedAt / decision-audit 等）；skipped → success:false + skipped。
 * 手写 interface（前端 proposalExec 按必填消费 success）；passthrough 兜扩展键；
 * parity 测试见 __tests__
 */
export interface ReviewProposalApproveResult {
  success: boolean;
  /** 预算熔断（提案保持 pending，可次日重试）；skipped 时 success=false */
  skipped?: string;
  [key: string]: unknown;
}
export const reviewProposalApproveResultSchema = z.object({
  success: z.boolean(),
  skipped: z.string().optional(),
}).passthrough();

/** reject 响应 data */
export const reviewProposalRejectResultSchema = z.object({
  success: z.boolean(),
});
export type ReviewProposalRejectResult = z.infer<typeof reviewProposalRejectResultSchema>;

/** status 响应 data（原 `{ success: true, status }` 的 success 标志退役） */
export const reviewProposalStatusResultSchema = z.object({
  status: reviewProposalStatusValueSchema,
});
export type ReviewProposalStatusResult = z.infer<typeof reviewProposalStatusResultSchema>;

export const reviewProposalApproveResponseSchema = dataBodySchema(reviewProposalApproveResultSchema);
export const reviewProposalRejectResponseSchema = dataBodySchema(reviewProposalRejectResultSchema);
export const reviewProposalStatusResponseSchema = dataBodySchema(reviewProposalStatusResultSchema);
