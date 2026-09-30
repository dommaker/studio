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

/**
 * Requirement wire 形状（含 B3a projectId：挂接的 PMO 项目 id；决策 4 别名视图同形返回）。
 * 手写 interface（z.infer 在本仓 strict:false 下全字段退化可选，见 workunit.ts 说明）；
 * parity 测试见 __tests__/requirements.test.ts。
 */
export interface Requirement {
  id: string; // REQ-<zero-padded seq>，如 REQ-0042
  seq: number;
  title: string;
  status: RequirementStatus;
  channelId?: string | null; // 来源频道（手动创建可无）
  createdAt: string; // ISO 8601
  createdBy: string; // mention | convert | manual | api | pmo-alias
  docs?: string[]; // 关联文档（需求文档 / SDD 路径）
  description?: string;
  projectId?: string | null; // B3a：挂接的 PMO 项目 id
}

export const requirementSchema = z.object({
  id: z.string(),
  seq: z.number(),
  title: z.string(),
  status: requirementStatusSchema,
  channelId: z.string().nullable().optional(),
  createdAt: z.string(),
  createdBy: z.string(),
  docs: z.array(z.string()).optional(),
  description: z.string().optional(),
  projectId: z.string().nullable().optional(),
});

/** getChain 返回的 WorkUnit 摘要（§10：自带 type/时间戳，消前端 N+1 详情补全）。
 *  手写 interface（消费方要求必填字段——WorkUnitDrawer/ProjectDetailPage 管道直接消费）；
 *  parity 测试见 __tests__/requirements.test.ts。 */
export interface RequirementChainWorkUnit {
  id: string;
  title: string;
  status: string;
  assigneeId: string | null;
  assigneeRoleId?: string | null; // 认领时的 roleId 快照（旧快照无 → null）
  metadata: string | null; // F6-b：链路节点徽章走 deriveDisplayState
  type: string;
  createdAt: string;
  claimedAt: string | null;
  completedAt: string | null;
}

export const requirementChainWorkUnitSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  assigneeId: z.string().nullable(),
  assigneeRoleId: z.string().nullable().optional(),
  metadata: z.string().nullable(),
  type: z.string(),
  createdAt: z.string(),
  claimedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});

/** 需求全链路（需求 + WorkUnit 摘要列表）。手写 interface（z.infer 退化可选，管道页按必填消费）；
 *  parity 测试见 __tests__/requirements.test.ts。 */
export interface RequirementChain {
  requirement: Requirement;
  workunits: RequirementChainWorkUnit[];
}

export const requirementChainSchema = z.object({
  requirement: requirementSchema,
  workunits: z.array(requirementChainWorkUnitSchema),
});

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

/** GET /chain-stats：`{ data: Record<reqId, { finished, total }> }`（不存在的需求 key 缺省）。
 *  ChainStatEntry 手写 interface（PMO 徽章按必填消费）；parity 测试见 __tests__。 */
export interface ChainStatEntry {
  finished: number;
  total: number;
}
export type ChainStatsResult = Record<string, ChainStatEntry>;

export const chainStatEntrySchema = z.object({ finished: z.number(), total: z.number() });
export const chainStatsResultSchema = z.record(z.string(), chainStatEntrySchema);
export const chainStatsResponseSchema = dataBodySchema(chainStatsResultSchema);
