/**
 * agent-profiles / agent-instances 域契约（批次 8/8）——实体类型与 studio-shared
 * file-store-types（AgentProfileData / RuntimeStateData）import type 同源 + 编译期互锚（#685），
 * schema 推型漂移即编译错误。
 *
 * 端点（route-registry /api/v1/agent-profiles、/api/v1/agent-instances）：
 *   GET    /agent-profiles           列表（status/channelId/includeSystem 过滤 + 分页）
 *   POST   /agent-profiles           创建（requireAuth + requireNotGuest；决策 9 preset 预填）
 *   GET    /agent-profiles/presets   角色 preset 清单（#633；须在 /:id 前注册）
 *   GET    /agent-profiles/:id       详情
 *   PATCH  /agent-profiles/:id       更新（只带脏字段；409 改名冲突同 create 口径）
 *   DELETE /agent-profiles/:id       删除（204；级联清频道成员/路由指名）
 *   POST   /agent-instances/:id/terminate  强制停止（requireAuth + requireAdmin；
 *          Phase 4 批5 后唯一活端点——管理面 GET/POST/PATCH 4 条孤儿端点已删，
 *          agent-instance.service 由 ops/agent-loop 直调不经 HTTP）
 *
 * wire 形状（defineRoute 统一壳后）：
 * - GET 列表原 `{ data, pagination }` ≡ paginated 分页壳，形状不变
 * - GET /presets 原已 `{ data }`，形状不变
 * - POST/GET/:id/PATCH/terminate 裸实体 → `{ data: T }`（前端消费方
 *   createAgent/updateAgent/getAgentInstance 同批改 res.data → res.data.data）
 * - name/roleId 必填由手写 400 INVALID_INPUT 收进 zod 400 BAD_REQUEST
 * - 409 DUPLICATE message 由定串变为 service 原始消息（含 'Unique constraint:' 前缀）
 * - 500 code 'INTERNAL_ERROR' 归一为 INTERNAL，message = 实际错误消息（原已是）
 */

import { z } from 'zod';
import type { AgentProfileData, RuntimeStateData } from '@dommaker/studio-shared/types';
import { dataBodySchema, paginatedBodySchema } from './envelope.js';
import type { MutualExtends } from './type-assert.js';

// ── 实体 ──

/**
 * 角色档案（= studio-shared AgentProfileData，import type 同源 + 下方互锚）。
 * channels 是 JSON 串（历史数据可能双重编码；§9.5 起写侧已停，channel.members 为成员关系唯一事实源）。
 */
export type AgentProfile = AgentProfileData;
export const agentProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  channels: z.string(),
  status: z.string(),
  provider: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  acceptedTypes: z.array(z.string()).optional(),
  persona: z.string().optional(),
  skills: z.array(z.string()).optional(),
  tools: z.array(z.string()).optional(),
  constraints: z.record(z.unknown()).optional(),
  kind: z.enum(['system', 'user']).optional(),
});
const _assertAgentProfile: MutualExtends<z.infer<typeof agentProfileSchema>, AgentProfileData> = true;

/**
 * 列表行 = AgentProfile + 实例态聚合三键（isOnline/最近启动失败；
 * agent-instance.service summarizeRoleStates 一次 listStates 产出）。
 */
export const agentProfileListItemSchema = agentProfileSchema.extend({
  isOnline: z.boolean(),
  lastError: z.string().nullable(),
  lastErrorAt: z.string().nullable(),
});
export type AgentProfileListItem = z.infer<typeof agentProfileListItemSchema>;

/** #633（ADR 2026-09-23-role-preset-surface）：preset 清单项（只回 name + description，死字段不浮出） */
export const rolePresetSummarySchema = z.object({
  name: z.string(),
  description: z.string().optional(),
});
export type RolePresetSummary = z.infer<typeof rolePresetSummarySchema>;

/** 运行实例（= studio-shared RuntimeStateData，import type 同源 + 下方互锚）。 */
export type AgentInstance = RuntimeStateData;
export const agentInstanceSchema = z.object({
  id: z.string(),
  roleId: z.string(),
  sessionId: z.string().nullable(),
  status: z.string(),
  currentWorkUnitId: z.string().nullable(),
  startedAt: z.string(),
  terminatedAt: z.string().nullable(),
  lastHeartbeat: z.string().nullable(),
  metadata: z.string().nullable(),
  pid: z.number().optional(),
  lastError: z.string().nullable().optional(),
  lastErrorAt: z.string().nullable().optional(),
  updatedAt: z.string().optional(),
});
const _assertAgentInstance: MutualExtends<z.infer<typeof agentInstanceSchema>, RuntimeStateData> = true;

// ── 请求 ──

/** GET /agent-profiles：page/limit 原样为字符串（parsePagination clamp）；includeSystem 串 'true' 才含系统角色（AC-1.4） */
export const agentProfileListQuerySchema = z.object({
  status: z.string().optional(),
  channelId: z.string().optional(),
  includeSystem: z.string().optional(),
  page: z.string().optional(),
  limit: z.string().optional(),
});
export type AgentProfileListQuery = z.infer<typeof agentProfileListQuerySchema>;

/** POST /agent-profiles：name 必填收进 zod（原手写 400 INVALID_INPUT）；preset 名防目录穿越在 service loadRolePreset */
export const createAgentProfileBodySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  channels: z.array(z.string()).optional(),
  provider: z.string().optional(),
  status: z.string().optional(),
  preset: z.string().optional(),
  persona: z.string().optional(),
  acceptedTypes: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
});
export type CreateAgentProfileBody = z.infer<typeof createAgentProfileBodySchema>;

/** PATCH /agent-profiles/:id：全可选（只带脏字段）；description/provider/persona null = 清空 */
export const updateAgentProfileBodySchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  channels: z.array(z.string()).optional(),
  provider: z.string().nullable().optional(),
  status: z.string().optional(),
  skills: z.array(z.string()).optional(),
  persona: z.string().nullable().optional(),
  acceptedTypes: z.array(z.string()).optional(),
});
export type UpdateAgentProfileBody = z.infer<typeof updateAgentProfileBodySchema>;

export const agentProfileIdParamsSchema = z.object({ id: z.string().min(1) });

/** POST /agent-instances/:id/terminate 的 params（Phase 4 批5 后 instance 域唯一请求 schema——
 * 管理面 list/create/update 三个 body/query schema 随孤儿端点同删） */
export const agentInstanceIdParamsSchema = z.object({ id: z.string().min(1) });

// ── 响应 ──

export const agentProfileListResponseSchema = paginatedBodySchema(agentProfileListItemSchema);
export const agentProfileResponseSchema = dataBodySchema(agentProfileSchema);
export const rolePresetListResponseSchema = dataBodySchema(z.array(rolePresetSummarySchema));
export const agentInstanceResponseSchema = dataBodySchema(agentInstanceSchema);
