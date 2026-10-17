/**
 * skills 域契约——正本字段以 apps/api/src/modules/skills/skill-store.ts（SkillRecord）、
 * manifest-loader.ts（SkillEntry 投影）、routes.ts 实测 wire 为准。
 *
 * 重构批次 P4.3（2026-10-17）：/api/v1/skills 面 16 条孤儿端点删除，
 * 随删 schema：discover/stats 查询与聚合响应、CRUD body、usage body、
 * demotion-proposals 全组、proposals 全组（scan/extract/retract）。
 * 保留 schema 只覆盖 3 条存活端点：
 * - GET /（listSkillsQuerySchema + skillListResponseSchema）
 * - GET /manifest（skillManifestResponseSchema）
 * - POST /:id/retract/decide（skillIdParamsSchema + retractDecideBodySchema + skillResponseSchema）
 */

import { z } from 'zod';
import { dataBodySchema, paginatedBodySchema } from './envelope.js';

// ── 实体：Skill（= skill-store.ts SkillRecord 全字段）──

/**
 * Skill wire 形状（skills-index.json 记录）。
 * agentTypes/tools/required/metadata 为 JSON 串（store 原样存取，路由不解析）。
 */
export const skillSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  roleId: z.string().nullable().optional(),
  name: z.string(),
  source: z.string(),
  status: z.string(),
  version: z.number(),
  category: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  prompt: z.string().nullable().optional(),
  trigger: z.string().nullable().optional(),
  agentTypes: z.string().nullable().optional(),
  tools: z.string().nullable().optional(),
  required: z.string().nullable().optional(),
  autoLoad: z.boolean(),
  isBuiltin: z.boolean(),
  usageCount: z.number(),
  successRate: z.number(),
  avgDuration: z.number(),
  metadata: z.string().nullable().optional(),
  extractedAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Skill = z.infer<typeof skillSchema>;

/** GET / 列表行：Skill + 最新一条 pending 提案 id（#354 提案存取归 review-proposal 正本） */
export const skillListItemSchema = skillSchema.extend({
  proposals: z.array(z.object({ id: z.string() })),
});
export type SkillListItem = z.infer<typeof skillListItemSchema>;

// ── 实体：SkillManifestEntry（#462 角色编辑 skill 多选候选）──

export const skillManifestEntrySchema = z.object({
  name: z.string(),
  description: z.string(),
  agentTypes: z.array(z.string()),
  triggers: z.array(z.string()),
});
export type SkillManifestEntry = z.infer<typeof skillManifestEntrySchema>;

// ── 请求：query / params ──

/** GET /（page/limit 数字串，handler 转 Number；旧行为 NaN 不 clamp，保持） */
export const listSkillsQuerySchema = z.object({
  companyId: z.string().optional(),
  status: z.string().optional(),
  category: z.string().optional(),
  roleId: z.string().optional(),
  page: z.string().optional(),
  limit: z.string().optional(),
});
export type ListSkillsQuery = z.infer<typeof listSkillsQuerySchema>;

export const skillIdParamsSchema = z.object({ id: z.string().min(1) });
export type SkillIdParams = z.infer<typeof skillIdParamsSchema>;

// ── 请求：body ──

/**
 * POST /:id/retract/decide（#278 决策 #250 D2）：confirm → deprecated、reject → 恢复 published；
 * messageId 提供时回写卡片 meta.status；channelId（#524 P1-1）按频道直查免全频道扇出。
 * 原手写 "decision must be 'confirm' or 'reject'" guard 收进 zod enum（文案变 zod 格式，仍 400）。
 */
export const retractDecideBodySchema = z.object({
  decision: z.enum(['confirm', 'reject']),
  messageId: z.string().optional(),
  channelId: z.string().optional(),
});
export type RetractDecideBody = z.infer<typeof retractDecideBodySchema>;

// ── 响应 ──

/** GET /：`{ data: SkillListItem[], pagination }`（原平铺 `{ data, total, page, limit }`，无消费方） */
export const skillListResponseSchema = paginatedBodySchema(skillListItemSchema);

/** GET /manifest：`{ data: SkillManifestEntry[] }`（原已带壳，形状不变） */
export const skillManifestResponseSchema = dataBodySchema(z.array(skillManifestEntrySchema));

/** POST /:id/retract/decide：`{ data: Skill }`（原已带壳） */
export const skillResponseSchema = dataBodySchema(skillSchema);
