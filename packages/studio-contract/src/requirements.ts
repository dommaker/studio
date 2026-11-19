/**
 * requirements 域契约——正本字段以 apps/api/src/modules/requirements/requirement.service.ts
 * （RequirementWithProject = studio-shared RequirementData + B3a projectId 扩展）与路由实际
 * wire 行为为准。
 *
 * wire 形状（defineRoute 统一壳后）：全部端点 `{ data: T }`（原 {success,data} 退役）。
 */

import { z } from 'zod';
import { dataBodySchema } from './envelope.js';

// ── 实体 ──

export const requirementStatusSchema = z.enum(['open', 'in-progress', 'done', 'archived']);
export type RequirementStatus = z.infer<typeof requirementStatusSchema>;

/** Requirement wire 形状（含 B3a projectId：挂接的 PMO 项目 id；决策 4 别名视图同形返回）。 */
export const requirementSchema = z.object({
  /** REQ-<zero-padded seq>，如 REQ-0042 */
  id: z.string(),
  seq: z.number(),
  title: z.string(),
  status: requirementStatusSchema,
  /** 来源频道（手动创建可无） */
  channelId: z.string().nullable().optional(),
  /** ISO 8601 */
  createdAt: z.string(),
  /** 词表：mention | convert | manual | api | pmo-alias */
  createdBy: z.string(),
  /** 关联文档（需求文档 / SDD 路径） */
  docs: z.array(z.string()).optional(),
  description: z.string().optional(),
  /** B3a：挂接的 PMO 项目 id */
  projectId: z.string().nullable().optional(),
});
export type Requirement = z.infer<typeof requirementSchema>;

/** getChain 返回的 WorkUnit 摘要（§10：自带 type/时间戳，消前端 N+1 详情补全）。 */
export const requirementChainWorkUnitSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  assigneeId: z.string().nullable(),
  /** 认领时的 roleId 快照（旧快照无 → null） */
  assigneeRoleId: z.string().nullable().optional(),
  /** F6-b：链路节点徽章走 deriveDisplayState */
  metadata: z.string().nullable(),
  type: z.string(),
  createdAt: z.string(),
  claimedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});
export type RequirementChainWorkUnit = z.infer<typeof requirementChainWorkUnitSchema>;

/** 需求全链路（需求 + WorkUnit 摘要列表）。 */
export const requirementChainSchema = z.object({
  requirement: requirementSchema,
  workunits: z.array(requirementChainWorkUnitSchema),
});
export type RequirementChain = z.infer<typeof requirementChainSchema>;

// ── 请求 ──

/** GET / 列表过滤（status 非法值 → 400，替代手写 includes 守卫） */
export const listRequirementsQuerySchema = z.object({
  status: requirementStatusSchema.optional(),
  channelId: z.string().optional(),
});
export type ListRequirementsQuery = z.infer<typeof listRequirementsQuerySchema>;

/** GET /chain-stats（reqIds = 逗号分隔 id，≤100 超出静默截断；全空白段视同缺失 → 400） */
export const chainStatsQuerySchema = z.object({
  reqIds: z.string().min(1).refine(
    (s) => s.split(',').some((x) => x.trim().length > 0),
    { message: 'reqIds is required (comma-separated ids)' },
  ),
});
export type ChainStatsQuery = z.infer<typeof chainStatsQuerySchema>;

export const requirementIdParamsSchema = z.object({ id: z.string().min(1) });
export type RequirementIdParams = z.infer<typeof requirementIdParamsSchema>;

/** POST / 手动创建（projectId 挂接 PMO 项目，不存在 → service 抛错映射 400） */
export const createRequirementBodySchema = z.object({
  title: z.string().trim().min(1),
  channelId: z.string().optional(),
  description: z.string().optional(),
  createdBy: z.string().optional(),
  docs: z.array(z.string()).optional(),
  projectId: z.string().nullable().optional(),
});
export type CreateRequirementBody = z.infer<typeof createRequirementBodySchema>;

/** PATCH /:id（全可选补丁；projectId null = 清除挂接；别名视图只读 → service 抛错映射 400） */
export const updateRequirementBodySchema = z.object({
  title: z.string().trim().min(1).optional(),
  status: requirementStatusSchema.optional(),
  description: z.string().optional(),
  docs: z.array(z.string()).optional(),
  projectId: z.string().nullable().optional(),
});
export type UpdateRequirementBody = z.infer<typeof updateRequirementBodySchema>;

// ── 响应 ──

/** GET /：`{ data: Requirement[] }` */
export const requirementListResponseSchema = dataBodySchema(z.array(requirementSchema));

/** 单 Requirement 端点通用壳：`{ data: Requirement }`（get/create 201/update） */
export const requirementResponseSchema = dataBodySchema(requirementSchema);

/** GET /:id/chain：`{ data: RequirementChain }` */
export const requirementChainResponseSchema = dataBodySchema(requirementChainSchema);

/** GET /chain-stats：`{ data: Record<reqId, { finished, total }> }`（不存在的需求 key 缺省）。 */
export const chainStatEntrySchema = z.object({ finished: z.number(), total: z.number() });
export type ChainStatEntry = z.infer<typeof chainStatEntrySchema>;
export type ChainStatsResult = Record<string, ChainStatEntry>;
export const chainStatsResultSchema = z.record(z.string(), chainStatEntrySchema);
export const chainStatsResponseSchema = dataBodySchema(chainStatsResultSchema);
