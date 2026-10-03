/**
 * skills 域契约——正本字段以 apps/api/src/modules/skills/skill-store.ts（SkillRecord）、
 * skill-demotion.ts（DemotionProposal/SkillUsageStats）、manifest-loader.ts（SkillEntry
 * 投影）、routes.ts / skill-proposal-routes.ts / skill-demotion-routes.ts 实测 wire 为准。
 *
 * wire 形状（defineRoute 统一壳后）：
 * - 全部端点 `{ data: T }`（GET /stats 平铺对象、DELETE 的 `{ success }`、
 *   proposals scan/extract/retract 平铺壳统一进壳）
 * - GET / 列表原 `{ data, total, page, limit }` 平铺分页 → 统一分页壳
 *   `{ data, pagination: { page, limit, total, totalPages } }`（无消费方）
 * - GET /demotion-proposals 的 scan 摘要兄弟键退役（无消费方）
 * - POST /:id/publish 的 promote 门禁拒绝体为错误壳扩展
 *   `{ error: { code, message, reasons } }`（handler 自写 res，HttpError 承载不了数组扩展）
 */

import { z } from 'zod';
import { dataBodySchema, paginatedBodySchema } from './envelope.js';

// ── 实体：Skill（= skill-store.ts SkillRecord 全字段）──

/**
 * Skill wire 形状（skills-index.json 记录）。手写 interface（z.infer 在本仓 strict:false
 * 下全字段退化可选；前端 retractDecide 按必填消费 id/status）；parity 测试见 __tests__。
 * agentTypes/tools/required/metadata 为 JSON 串（store 原样存取，路由不解析）。
 */
export interface Skill {
  id: string;
  companyId: string;
  roleId?: string | null;
  name: string;
  source: string;
  status: string;
  version: number;
  category?: string | null;
  description?: string | null;
  prompt?: string | null;
  trigger?: string | null;
  agentTypes?: string | null;
  tools?: string | null;
  required?: string | null;
  autoLoad: boolean;
  isBuiltin: boolean;
  usageCount: number;
  successRate: number;
  avgDuration: number;
  metadata?: string | null;
  extractedAt: string;
  createdAt: string;
  updatedAt: string;
}

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

/** GET / 列表行：Skill + 最新一条 pending 提案 id（#354 提案存取归 review-proposal 正本） */
export const skillListItemSchema = skillSchema.extend({
  proposals: z.array(z.object({ id: z.string() })),
});
export type SkillListItem = z.infer<typeof skillListItemSchema>;

/** GET /:id 提案视图（旧 ProposalRecord 字段名：proposedAt←createdAt，reviewedAt←statusAt） */
export const skillProposalViewSchema = z.object({
  id: z.string(),
  skillId: z.string(),
  status: z.string(),
  proposedBy: z.string(),
  summary: z.string().nullable(),
  proposedAt: z.string(),
  reviewedAt: z.string().nullable(),
});
export type SkillProposalView = z.infer<typeof skillProposalViewSchema>;

/** GET /:id 响应 data：Skill + 最近 10 条提案视图 */
export const skillDetailSchema = skillSchema.extend({
  proposals: z.array(skillProposalViewSchema),
});
export type SkillDetail = z.infer<typeof skillDetailSchema>;

// ── 实体：SkillManifestEntry（#462 角色编辑 skill 多选候选）──

export const skillManifestEntrySchema = z.object({
  name: z.string(),
  description: z.string(),
  agentTypes: z.array(z.string()),
  triggers: z.array(z.string()),
});
/** 手写 interface（前端 RoleSkillsModal 按必填消费）；parity 测试见 __tests__ */
export interface SkillManifestEntry {
  name: string;
  description: string;
  agentTypes: string[];
  triggers: string[];
}

// ── 实体：SkillStats（GET /stats 聚合）──

export const skillTopEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  usageCount: z.number(),
  successRate: z.number(),
  avgDuration: z.number(),
});
export type SkillTopEntry = z.infer<typeof skillTopEntrySchema>;

export const skillsStatsSchema = z.object({
  totalSkills: z.number(),
  publishedSkills: z.number(),
  totalUsage: z.number(),
  avgSuccessRate: z.number(),
  avgDuration: z.number(),
  byCategory: z.record(z.object({ count: z.number(), usage: z.number() })),
  topSkills: z.array(skillTopEntrySchema),
});
export type SkillsStats = z.infer<typeof skillsStatsSchema>;

// ── 实体：DemotionProposal（skill-demotion.ts，§10.6 降级通路）──

export const skillUsageStatsSchema = z.object({
  uses: z.number(),
  /** 终态 WU 成功率（使用归因）；无关联终态 WU → null（未知，不编造） */
  successRate: z.number().nullable(),
  lastUsedAt: z.string().nullable(),
  /** 曝光计数（matchedSkills 命中，仅人审参考，不参与 demote 判定） */
  exposures: z.number(),
});
export type SkillUsageStats = z.infer<typeof skillUsageStatsSchema>;

export const demotionKindSchema = z.enum(['archive', 'demote']);
export type DemotionKind = z.infer<typeof demotionKindSchema>;

export const demotionProposalSchema = z.object({
  id: z.string(),
  skillName: z.string(),
  kind: demotionKindSchema,
  status: z.enum(['pending', 'approved', 'rejected']),
  reason: z.string(),
  stats: skillUsageStatsSchema.extend({ ageDays: z.number() }),
  suggestedStatus: z.literal('archived'),
  createdAt: z.string(),
  reviewedAt: z.string().nullable(),
});
/** 手写 interface（实体，与 skill-demotion.ts DemotionProposal 对应）；parity 测试见 __tests__ */
export interface DemotionProposal {
  id: string;
  skillName: string;
  kind: DemotionKind;
  status: 'pending' | 'approved' | 'rejected';
  reason: string;
  stats: SkillUsageStats & { ageDays: number };
  suggestedStatus: 'archived';
  createdAt: string;
  reviewedAt: string | null;
}

// ── 提案提取（skill-proposal-routes）──

/** POST /proposals/scan 与 /extract 的保存结果（saveProposal 返回） */
export const savedSkillProposalSchema = z.object({
  skillId: z.string(),
  proposalId: z.string(),
  autoPublished: z.boolean(),
});
export type SavedSkillProposal = z.infer<typeof savedSkillProposalSchema>;

/** POST /proposals/scan 响应 data */
export const scanSkillProposalsResultSchema = z.object({
  scanned: z.number(),
  saved: z.number(),
  proposals: z.array(savedSkillProposalSchema),
});
export type ScanSkillProposalsResult = z.infer<typeof scanSkillProposalsResultSchema>;

/** POST /proposals/extract/:executionId 响应 data（判别：extracted false=无可复用模式） */
export const extractSkillProposalResultSchema = z.object({
  extracted: z.boolean(),
  message: z.string().optional(),
  skillId: z.string().optional(),
  proposalId: z.string().optional(),
  autoPublished: z.boolean().optional(),
  /** 提取出的提案（LLM 分析结果；字段为 best-effort） */
  proposal: z.record(z.unknown()).optional(),
});
export type ExtractSkillProposalResult = z.infer<typeof extractSkillProposalResultSchema>;

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

/** GET /discover（q → name contains 模糊匹配） */
export const discoverSkillsQuerySchema = z.object({
  companyId: z.string().optional(),
  category: z.string().optional(),
  roleId: z.string().optional(),
  q: z.string().optional(),
  limit: z.string().optional(),
});
export type DiscoverSkillsQuery = z.infer<typeof discoverSkillsQuerySchema>;

/** GET /stats（company_id 下划线命名，旧 wire 如此） */
export const skillsStatsQuerySchema = z.object({
  company_id: z.string().optional(),
});
export type SkillsStatsQuery = z.infer<typeof skillsStatsQuerySchema>;

export const skillIdParamsSchema = z.object({ id: z.string().min(1) });
export type SkillIdParams = z.infer<typeof skillIdParamsSchema>;

/** GET /demotion-proposals（scan=true 先跑一次扫描；status 过滤） */
export const listDemotionProposalsQuerySchema = z.object({
  status: z.string().optional(),
  scan: z.string().optional(),
});
export type ListDemotionProposalsQuery = z.infer<typeof listDemotionProposalsQuerySchema>;

export const demotionProposalIdParamsSchema = z.object({ id: z.string().min(1) });
export type DemotionProposalIdParams = z.infer<typeof demotionProposalIdParamsSchema>;

/** GET /proposals（companyId 必填；原 VALIDATION 手写校验收进 zod） */
export const listSkillProposalsQuerySchema = z.object({
  companyId: z.string().min(1),
});
export type ListSkillProposalsQuery = z.infer<typeof listSkillProposalsQuerySchema>;

export const executionIdParamsSchema = z.object({ executionId: z.string().min(1) });
export type ExecutionIdParams = z.infer<typeof executionIdParamsSchema>;

// ── 请求：body ──

/** POST / 创建（companyId/name 必填——原手写 guard 收进 zod；metadata 任意 JSON 由 store stringify） */
export const createSkillBodySchema = z.object({
  companyId: z.string().min(1),
  name: z.string().min(1),
  roleId: z.string().optional(),
  category: z.string().optional(),
  description: z.string().optional(),
  metadata: z.unknown().optional(),
  source: z.string().optional(),
});
export type CreateSkillBody = z.infer<typeof createSkillBodySchema>;

/** PATCH /:id（全可选；metadata 同 POST） */
export const updateSkillBodySchema = z.object({
  name: z.string().optional(),
  category: z.string().optional(),
  description: z.string().optional(),
  metadata: z.unknown().optional(),
  roleId: z.string().optional(),
});
export type UpdateSkillBody = z.infer<typeof updateSkillBodySchema>;

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

/**
 * POST /:id/usage（EMA 统计更新）。success 原按 truthy 消费，zod 收紧为 boolean
 * （非 boolean 原静默按 truthy 计 → 400）；durationMs 缺省则不更新 avgDuration。
 */
export const recordSkillUsageBodySchema = z.object({
  success: z.boolean().optional(),
  durationMs: z.number().optional(),
});
export type RecordSkillUsageBody = z.infer<typeof recordSkillUsageBodySchema>;

/** POST /proposals/scan（companyId 必填——原 VALIDATION 手写校验收进 zod） */
export const scanSkillProposalsBodySchema = z.object({
  companyId: z.string().min(1),
});
export type ScanSkillProposalsBody = z.infer<typeof scanSkillProposalsBodySchema>;

// ── 响应 ──

/** GET /：`{ data: SkillListItem[], pagination }`（原平铺 `{ data, total, page, limit }`，无消费方） */
export const skillListResponseSchema = paginatedBodySchema(skillListItemSchema);

/** GET /discover / GET /manifest：`{ data: T[] }`（原已带壳，形状不变） */
export const skillDiscoverResponseSchema = dataBodySchema(z.array(skillSchema));
export const skillManifestResponseSchema = dataBodySchema(z.array(skillManifestEntrySchema));

/** GET /:id：`{ data: SkillDetail }`（原已带壳，形状不变） */
export const skillDetailResponseSchema = dataBodySchema(skillDetailSchema);

/** POST(201)/PATCH / publish/deprecate/retract-decide/restore/usage：`{ data: Skill }`（原已带壳） */
export const skillResponseSchema = dataBodySchema(skillSchema);

/** DELETE /:id：`{ data: { success } }`（原平铺 `{ success: true }`） */
export const deleteSkillResultSchema = z.object({ success: z.boolean() });
export type DeleteSkillResult = z.infer<typeof deleteSkillResultSchema>;
export const deleteSkillResponseSchema = dataBodySchema(deleteSkillResultSchema);

/** GET /stats：`{ data: SkillsStats }`（原平铺裸对象） */
export const skillsStatsResponseSchema = dataBodySchema(skillsStatsSchema);

/** GET /demotion-proposals：`{ data: DemotionProposal[] }`（scan 摘要兄弟键退役，无消费方） */
export const demotionProposalListResponseSchema = dataBodySchema(z.array(demotionProposalSchema));

/** POST /demotion-proposals/:id/approve|reject：`{ data: { success, status } }`（原平铺） */
export const reviewDemotionResultSchema = z.object({
  success: z.boolean(),
  status: z.enum(['approved', 'rejected']),
});
export type ReviewDemotionResult = z.infer<typeof reviewDemotionResultSchema>;
export const reviewDemotionResponseSchema = dataBodySchema(reviewDemotionResultSchema);

/** GET /proposals：`{ data: (pending 提案 + skill)[] }`（原已带壳；行形状 best-effort） */
export const skillProposalListResponseSchema = dataBodySchema(z.array(z.record(z.unknown())));

/** POST /proposals/scan：`{ data: ScanSkillProposalsResult }`（原平铺） */
export const scanSkillProposalsResponseSchema = dataBodySchema(scanSkillProposalsResultSchema);

/** POST /proposals/extract/:executionId：`{ data: ExtractSkillProposalResult }`（原平铺） */
export const extractSkillProposalResponseSchema = dataBodySchema(extractSkillProposalResultSchema);

/** POST /proposals/:id/retract：`{ data: { success, status } }`（原平铺） */
export const retractSkillResultSchema = z.object({
  success: z.boolean(),
  status: z.literal('under_review'),
});
export type RetractSkillResult = z.infer<typeof retractSkillResultSchema>;
export const retractSkillResponseSchema = dataBodySchema(retractSkillResultSchema);
