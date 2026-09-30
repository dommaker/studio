/**
 * iron-laws 域契约（批次 6/7）——正本以 apps/api/src/modules/harness/
 * iron-laws.routes.ts（直连 @dommaker/harness getAllConstraints/getConstraint/
 * checkConstraint/checkConstraints）实测 wire 为准。
 *
 * 四个端点（route-registry /api/v1/iron-laws 公开挂载）：
 *   GET  /           铁律清单
 *   GET  /:id        单条铁律
 *   POST /check      单约束检查（lawId 可为 string[] 批量；#641 证据标志剥离）
 *   POST /check-all  全量检查（block 模式违规抛 → 部分视图数据返回）
 *
 * wire 形状（defineRoute 统一壳后）：
 * - `{ success:true, data, count, source:'harness' }` 壳退役：GET / → `{ data: laws[] }`、
 *   GET /:id → `{ data: law }`（count = length 冗余、source 常量、success 恒 true，均无消费方）
 * - POST /check `{ success, data, source, strippedEvidenceFlags? }` →
 *   `{ data: { result, strippedEvidenceFlags? } }`
 * - POST /check-all `{ success, data, source, strippedEvidenceFlags?, degradedChecks?,
 *   violationPartialView? }` → `{ data: { results, strippedEvidenceFlags?, degradedChecks?,
 *   violationPartialView? } }`
 * - 400 MISSING_LAW_ID/MISSING_CONTEXT 手写码退役 → zod BAD_REQUEST（文案变 zod 格式）；
 *   404 IRON_LAW_NOT_FOUND 机器串保留；500 code IRON_LAW(S)_*_ERROR 归一 INTERNAL、
 *   message 由固定串变为实际错误消息
 */

import { z } from 'zod';
import { dataBodySchema } from './envelope.js';
import {
  constraintCheckResultSchema,
  constraintResultItemSchema,
  violationPartialViewSchema,
} from './harness.js';

/** 铁律条目 wire（harness Constraint；字段全集归 harness，passthrough 放行） */
export const ironLawSchema = z.object({
  id: z.string(),
}).passthrough();
export type IronLaw = z.infer<typeof ironLawSchema>;

// ── 请求 ──

/** context 用 record（不是 object）——#641 sanitize 要读 has* 证据标志键，
 * zod object 剥未知键会抢先剥掉（defineRoute 坑①） */
export const constraintContextSchema = z.record(z.unknown());

export const ironLawCheckBodySchema = z.object({
  lawId: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  context: constraintContextSchema,
});
export type IronLawCheckBody = z.infer<typeof ironLawCheckBodySchema>;

export const ironLawCheckAllBodySchema = z.object({
  context: constraintContextSchema,
});
export type IronLawCheckAllBody = z.infer<typeof ironLawCheckAllBodySchema>;

export const ironLawIdParamsSchema = z.object({ id: z.string().min(1) });

// ── 响应 data ──

/** POST /check 响应 data（result：单条 ConstraintResult 或 lawId 数组的 id→result 映射） */
export const ironLawCheckResultSchema = z.object({
  result: z.union([constraintResultItemSchema, z.record(constraintResultItemSchema)]),
  strippedEvidenceFlags: z.array(z.string()).optional(),
});
export type IronLawCheckResult = z.infer<typeof ironLawCheckResultSchema>;

/** POST /check-all 响应 data */
export const ironLawCheckAllResultSchema = z.object({
  results: constraintCheckResultSchema,
  strippedEvidenceFlags: z.array(z.string()).optional(),
  degradedChecks: z.array(z.object({
    id: z.string(),
    skipReason: z.string().optional(),
  })).optional(),
  violationPartialView: violationPartialViewSchema.optional(),
});
export type IronLawCheckAllResult = z.infer<typeof ironLawCheckAllResultSchema>;

// ── 响应（统一 `{ data }` 壳）──

export const ironLawListResponseSchema = dataBodySchema(z.array(ironLawSchema));
export const ironLawGetResponseSchema = dataBodySchema(ironLawSchema);
export const ironLawCheckResponseSchema = dataBodySchema(ironLawCheckResultSchema);
export const ironLawCheckAllResponseSchema = dataBodySchema(ironLawCheckAllResultSchema);
