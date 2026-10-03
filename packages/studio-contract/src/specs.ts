/**
 * specs 域契约——正本字段以 packages/studio-spec 的 types/change.types.ts
 * （AnalyzeChangeResult/ChangeRecord/SpecContent）与 types/gate.types.ts
 * （ValidateChangeResult/GatePolicy/CheckResult）、services/change-history.service.ts
 * （getStats）为准。studio-spec 引 harness/Node 依赖，契约包只重声明 wire 形状不 import。
 *
 * wire 形状（defineRoute 统一壳后）：
 * - 全部 JSON 端点 `{ data: T }`（原已带壳，形状不变）
 * - GET /:id/changes 走统一分页壳 `{ data, pagination }`（原 sendPaginated 同形状）
 * - GET /:id/changes/export 为附件下载（Content-Disposition），handler 自写 res，不进壳
 * - ChangeRecord 的 Date 字段（submittedAt/approvedAt/appliedAt）wire 上为 ISO 串
 */

import { z } from 'zod';
import { dataBodySchema, paginatedBodySchema } from './envelope.js';

// ── 共用词表 ──

export const changeLevelSchema = z.enum(['L1', 'L2', 'L3', 'L4']);
export type ChangeLevel = z.infer<typeof changeLevelSchema>;

/** SpecContent（解析后 spec 内容；业务字段按需扩展，契约只锚定 metadata.id，其余 passthrough） */
export const specContentSchema = z.object({
  metadata: z.object({
    id: z.string(),
    title: z.string().optional(),
    status: z.enum(['draft', 'in_progress', 'completed', 'deprecated']).optional(),
    created: z.string().optional(),
    updated: z.string().optional(),
  }).passthrough(),
  architecture: z.object({
    dependencies: z.array(z.string()).optional(),
    data_models: z.array(z.string()).optional(),
  }).passthrough().optional(),
  api: z.object({
    endpoints: z.array(z.object({
      path: z.string(),
      method: z.string(),
      request: z.string().optional(),
      response: z.string().optional(),
    }).passthrough()).optional(),
    schemas: z.record(z.object({
      type: z.string(),
      properties: z.record(z.unknown()).optional(),
    }).passthrough()).optional(),
  }).passthrough().optional(),
  acceptance_criteria: z.array(z.object({
    id: z.string(),
    description: z.string(),
    test: z.string().optional(),
    passes: z.boolean().optional(),
  }).passthrough()).optional(),
}).passthrough();
export type SpecContentWire = z.infer<typeof specContentSchema>;

// ── 变更分析（POST /:id/analyze-change）──

export const approvalProcessSchema = z.object({
  type: z.enum(['auto', 'gate_checker', 'single_approval', 'multi_approval']),
  requiredApprovers: z.number().optional(),
  description: z.string(),
  estimatedTime: z.string(),
});
export type ApprovalProcessWire = z.infer<typeof approvalProcessSchema>;

export const changeDetailSchema = z.object({
  type: z.string(),
  area: z.string(),
  description: z.string(),
  oldValue: z.unknown().optional(),
  newValue: z.unknown().optional(),
});
export type ChangeDetailWire = z.infer<typeof changeDetailSchema>;

export const analyzeChangeResultSchema = z.object({
  level: changeLevelSchema,
  changeTypes: z.array(z.string()),
  affectedAreas: z.array(z.string()),
  riskScore: z.number(),
  recommendedApproval: approvalProcessSchema,
  summary: z.string(),
  changes: z.array(changeDetailSchema),
});
export type AnalyzeChangeResultWire = z.infer<typeof analyzeChangeResultSchema>;

// ── 变更记录（ChangeHistoryService）──

export const changeRecordSchema = z.object({
  id: z.string(),
  specId: z.string(),
  level: changeLevelSchema,
  changeTypes: z.array(z.string()),
  summary: z.string(),
  status: z.enum(['pending', 'auto_approved', 'approved', 'rejected', 'applied']),
  submittedBy: z.string(),
  /** Date 序列化为 ISO 串 */
  submittedAt: z.string(),
  approvedBy: z.string().optional(),
  approvedAt: z.string().optional(),
  appliedAt: z.string().optional(),
  oldVersion: specContentSchema,
  newVersion: specContentSchema,
  approvers: z.array(z.string()).optional(),
});
export type ChangeRecordWire = z.infer<typeof changeRecordSchema>;

/** GET /:id/changes/stats 响应 data */
export const changeStatsSchema = z.object({
  total: z.number(),
  byLevel: z.object({ L1: z.number(), L2: z.number(), L3: z.number(), L4: z.number() }),
  byStatus: z.record(z.number()),
  recentChanges: z.array(changeRecordSchema),
});
export type ChangeStatsWire = z.infer<typeof changeStatsSchema>;

// ── 门禁（GateCheckerService）──

export const checkResultSchema = z.object({
  type: z.string(),
  passed: z.boolean(),
  message: z.string(),
  details: z.record(z.unknown()).optional(),
});
export type CheckResultWire = z.infer<typeof checkResultSchema>;

export const validateChangeResultSchema = z.object({
  changeId: z.string(),
  level: changeLevelSchema,
  passed: z.boolean(),
  checks: z.array(checkResultSchema),
  summary: z.string(),
  canProceed: z.boolean(),
});
export type ValidateChangeResultWire = z.infer<typeof validateChangeResultSchema>;

export const gatePolicySchema = z.object({
  level: changeLevelSchema,
  checkpoints: z.array(z.string()),
  autoApprove: z.boolean(),
  requiresHumanReview: z.boolean(),
  description: z.string(),
});
export type GatePolicyWire = z.infer<typeof gatePolicySchema>;

/** POST /:id/changes/import 响应 data */
export const importChangesResultSchema = z.object({ imported: z.number() });
export type ImportChangesResult = z.infer<typeof importChangesResultSchema>;

// ── 请求：query / params ──

export const specIdParamsSchema = z.object({ id: z.string().min(1) });
export type SpecIdParams = z.infer<typeof specIdParamsSchema>;

export const changeIdParamsSchema = z.object({ changeId: z.string().min(1) });
export type ChangeIdParams = z.infer<typeof changeIdParamsSchema>;

/**
 * GET /gates/:level——非法 level 原返回 `{ data: undefined }`（200 空体边缘），
 * zod enum 收紧为 400。
 */
export const gateLevelParamsSchema = z.object({ level: changeLevelSchema });
export type GateLevelParams = z.infer<typeof gateLevelParamsSchema>;

/** GET /:id/changes（page/limit 数字串，parsePagination clamp 1..100 缺省 20） */
export const listSpecChangesQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
});
export type ListSpecChangesQuery = z.infer<typeof listSpecChangesQuerySchema>;

// ── 请求：body ──

/** POST /:id/analyze-change（原 "Missing oldVersion or newVersion" 手写校验收进 zod） */
export const analyzeChangeBodySchema = z.object({
  oldVersion: specContentSchema,
  newVersion: specContentSchema,
});
export type AnalyzeChangeBody = z.infer<typeof analyzeChangeBodySchema>;

/** POST /changes/:changeId/validate（全可选；checkpoints 缺省按变更级别取策略） */
export const validateChangeBodySchema = z.object({
  checkpoints: z.array(z.string()).optional(),
  harnessConfigs: z.array(z.object({
    type: z.string(),
    harness: z.record(z.unknown()).optional(),
  }).passthrough()).optional(),
  strictMode: z.boolean().optional(),
});
export type ValidateChangeBody = z.infer<typeof validateChangeBodySchema>;

/** POST /:id/changes/import（原 "Missing data" 手写校验收进 zod） */
export const importChangesBodySchema = z.object({
  data: z.string().min(1),
});
export type ImportChangesBody = z.infer<typeof importChangesBodySchema>;

// ── 响应（全部原已带 `{ data }` 壳，形状不变）──

export const analyzeChangeResponseSchema = dataBodySchema(analyzeChangeResultSchema);
export const changeRecordResponseSchema = dataBodySchema(changeRecordSchema);
export const validateChangeResponseSchema = dataBodySchema(validateChangeResultSchema);
export const gatePolicyResponseSchema = dataBodySchema(gatePolicySchema);
export const gatePolicyMapResponseSchema = dataBodySchema(z.record(gatePolicySchema));
export const specChangeListResponseSchema = paginatedBodySchema(changeRecordSchema);
export const changeStatsResponseSchema = dataBodySchema(changeStatsSchema);
export const importChangesResponseSchema = dataBodySchema(importChangesResultSchema);
