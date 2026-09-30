/**
 * evolution 域契约——正本字段以 packages/studio-shared file-store-types.ts
 * （EvolutionProposalData）与 apps/api/src/modules/evolution/generator.ts
 * （GenerationResult）、constraint-adapter.ts（ConstraintProposal/ConstraintScanResult）、
 * evolution.routes.ts 实测 wire 为准。studio-shared 带 Node 依赖，契约包只重声明
 * wire 形状不 import。
 *
 * wire 形状（defineRoute 统一壳后）：
 * - 全部端点 `{ data: T }`（原 `{ success: true, data }` 壳的 success 标志退役）
 * - 错误统一 `{ error: { code, message } }`（原 `{ success: false, error: string }`；
 *   EvolutionError code NOT_FOUND→404 / CONFLICT→409 / APPLY_FAILED→500 保持）
 * - 通用提案卡审批端点 /api/v1/review-proposals/evolution/:id/* 归批次 4，不在本文件
 */

import { z } from 'zod';
import { dataBodySchema } from './envelope.js';

// ── 实体：EvolutionProposal（= EvolutionProposalData）──

export const evolutionTargetTypeSchema = z.enum(['iron-law', 'guideline', 'prompt-template', 'role-preset']);
export type EvolutionTargetTypeWire = z.infer<typeof evolutionTargetTypeSchema>;

/** stale：pending/approved 超期未审（TTL，#602 D2）惰性转 stale */
export const evolutionProposalStatusSchema = z.enum(['pending', 'approved', 'rejected', 'applied', 'stale']);
export type EvolutionProposalStatusWire = z.infer<typeof evolutionProposalStatusSchema>;

export const evolutionEvidenceSchema = z.object({
  windowHours: z.number(),
  eventCounts: z.record(z.number()),
  samples: z.array(z.string()).optional(),
});
export type EvolutionEvidenceWire = z.infer<typeof evolutionEvidenceSchema>;

export const evolutionProposalSchema = z.object({
  /** EP-<zero-padded seq>，如 EP-0042 */
  id: z.string(),
  seq: z.number(),
  targetType: evolutionTargetTypeSchema,
  targetId: z.string(),
  action: z.enum(['add', 'amend']),
  /** 仅 iron-law/guideline：retire=退役（墓碑+知识条目）；disable=临时停用 */
  constraintChange: z.enum(['retire', 'disable']).optional(),
  currentText: z.string(),
  proposedText: z.string(),
  rationale: z.string(),
  evidence: evolutionEvidenceSchema,
  status: evolutionProposalStatusSchema,
  source: z.string(),
  createdAt: z.string(),
  decidedBy: z.string().nullable().optional(),
  decidedAt: z.string().nullable().optional(),
  appliedAt: z.string().nullable().optional(),
  rejectReason: z.string().nullable().optional(),
  staledAt: z.string().nullable().optional(),
});

/** 手写 interface（实体，前后端解包后按必填消费）；parity 测试见 __tests__ */
export interface EvolutionProposal {
  id: string;
  seq: number;
  targetType: EvolutionTargetTypeWire;
  targetId: string;
  action: 'add' | 'amend';
  constraintChange?: 'retire' | 'disable';
  currentText: string;
  proposedText: string;
  rationale: string;
  evidence: EvolutionEvidenceWire;
  status: EvolutionProposalStatusWire;
  source: string;
  createdAt: string;
  decidedBy?: string | null;
  decidedAt?: string | null;
  appliedAt?: string | null;
  rejectReason?: string | null;
  staledAt?: string | null;
}

// ── runScan 结果（POST /run）──

/** 约束提案（constraint-adapter.ts，子项 7/8 知识→约束候选） */
export const constraintProposalSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  action: z.enum(['new', 'upgrade']),
  repoRoot: z.string(),
  constraintId: z.string(),
  rule: z.string(),
  checker: z.enum(['regex-scan', 'file-exists']).nullable(),
  params: z.record(z.unknown()),
  severity: z.enum(['error', 'warning', 'info']),
  message: z.string(),
  statsText: z.string().optional(),
  sourceEntry: z.object({ id: z.string(), title: z.string() }).optional(),
});
export type ConstraintProposalWire = z.infer<typeof constraintProposalSchema>;

export const constraintScanResultSchema = z.object({
  created: z.array(constraintProposalSchema),
  skipped: z.record(z.number()),
  posted: z.number(),
});
export type ConstraintScanResultWire = z.infer<typeof constraintScanResultSchema>;

/** POST /run 响应 data（GenerationResult + posted + 可选 constraintScan） */
export const evolutionRunResultSchema = z.object({
  created: z.array(evolutionProposalSchema),
  /** 跳过原因 → 计数（unsupported-type / duplicate / open-exists / report-only-candidate 等） */
  skipped: z.record(z.number()),
  /** 本轮 TTL 清扫转 stale 的提案 id（#602 D2） */
  staled: z.array(z.string()),
  scanned: z.object({
    constraintTraces: z.number(),
    toolCalls: z.number(),
    outcomes: z.number(),
    incidents: z.number(),
  }),
  posted: z.number(),
  constraintScan: constraintScanResultSchema.optional(),
});
export type EvolutionRunResult = z.infer<typeof evolutionRunResultSchema>;

// ── 请求：query / params / body ──

/** GET /proposals（status/targetType 过滤，均为非空串才生效） */
export const listEvolutionProposalsQuerySchema = z.object({
  status: z.string().optional(),
  targetType: z.string().optional(),
});
export type ListEvolutionProposalsQuery = z.infer<typeof listEvolutionProposalsQuerySchema>;

export const evolutionProposalIdParamsSchema = z.object({ id: z.string().min(1) });
export type EvolutionProposalIdParams = z.infer<typeof evolutionProposalIdParamsSchema>;

/** POST /proposals/:id/approve|reject（reason 可选；decidedBy 缺省 api:<user>） */
export const decideEvolutionBodySchema = z.object({
  reason: z.string().optional(),
  decidedBy: z.string().optional(),
});
export type DecideEvolutionBody = z.infer<typeof decideEvolutionBodySchema>;

// ── 响应（原 `{ success, data }` 壳统一为 `{ data }`）──

export const evolutionProposalListResponseSchema = dataBodySchema(z.array(evolutionProposalSchema));
export const evolutionProposalResponseSchema = dataBodySchema(evolutionProposalSchema);
export const evolutionRunResponseSchema = dataBodySchema(evolutionRunResultSchema);
