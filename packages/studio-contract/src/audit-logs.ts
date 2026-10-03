/**
 * audit-logs 域契约（批次 6/7）——正本以 apps/api/src/modules/audit-logs/
 * routes.ts + packages/studio-audit audit-service.ts（AuditLogRow/AuditLogStats/
 * AuditLogInput）+ proposal-source.ts（ProposalDecisionRow）实测 wire 为准。
 *
 * 七个端点（route-registry /api/v1/audit-logs 挂 admin）：
 *   GET  /          查询（parsePagination clamp 1..100 留 handler；
 *                   source=proposal|all 合并 review-proposal 聚合行统一排序分页）
 *   GET  /stats     统计汇总
 *   GET  /actions   操作类型词表
 *   GET  /resources 资源类型词表
 *   GET  /export    附件下载（Content-Disposition；handler 自写 res 不进壳）
 *   GET  /:id       单条（操作轨未命中回查提案源）
 *   POST /          创建（201 空体：service.log 返回 void）
 *
 * wire 形状（defineRoute 统一壳后）：
 * - GET / 分页壳 `{ data, pagination }` 原已同形（formatPaginatedResponse ≡ paginated），不变
 * - GET /actions|/resources 原已 `{ data: string[] }`，不变
 * - GET /stats 裸对象 → `{ data: AuditLogStats }`；GET /:id 裸行 → `{ data: row }`
 * - POST / 201 空体不变
 * - 错误统一 `{ error: { code, message } }`（原 500 已同形但 code 'INTERNAL_ERROR'
 *   归一为 INTERNAL；message 由固定串变为实际错误消息）
 */

import { z } from 'zod';
import { dataBodySchema, paginatedBodySchema } from './envelope.js';

// ── 实体 ──

/**
 * 审计行 wire（AuditService AuditLogRow ⊕ proposal-source ProposalDecisionRow；
 * 提案行是操作轨子集同形——actorType 恒 'agent'、action 恒 'propose'、details 恒 string|null）。
 * 历史行稀疏（可选键缺省即不存在）→ passthrough 放行扩展键。
 * details/changes 落盘为 JSON 串；读取原样透传 → wire = string|null
 * （前端 api/auditLogs.ts normalizeRow 归一为对象消费，union 声明双形态，knowledge tags 先例）。
 */
export const auditLogRowSchema = z.object({
  id: z.string(),
  userId: z.string().optional(),
  roleId: z.string().optional(),
  companyId: z.string().optional(),
  ipAddress: z.string().optional(),
  userAgent: z.string().optional(),
  action: z.string(),
  resource: z.string(),
  resourceId: z.string().optional(),
  details: z.union([z.string(), z.record(z.unknown())]).nullish(),
  changes: z.union([
    z.string(),
    z.object({
      before: z.record(z.unknown()).optional(),
      after: z.record(z.unknown()).optional(),
      fields: z.array(z.string()).optional(),
    }),
  ]).nullish(),
  status: z.string(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
  sessionId: z.string().optional(),
  requestId: z.string().optional(),
  /** #591：操作主体；存量行无此字段（读取侧按 human 归一） */
  actorType: z.enum(['human', 'agent']).optional(),
  createdAt: z.string(),
}).passthrough();

export type AuditLogRow = z.infer<typeof auditLogRowSchema>;

/**
 * 前端消费形状（normalizeRow 归一后：details/changes 恒为对象|undefined）。
 * 手写 interface（AuditLogsPage 按必填消费 id/action/resource/status/createdAt）；parity 见 __tests__
 */
export interface AuditLog {
  id: string;
  userId?: string;
  roleId?: string;
  companyId?: string;
  ipAddress?: string;
  userAgent?: string;
  action: string;
  resource: string;
  resourceId?: string;
  details?: Record<string, unknown>;
  changes?: {
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    fields?: string[];
  };
  status: string;
  actorType?: 'human' | 'agent';
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
}

/** GET /stats 响应 data。手写 interface（AuditLogsPage 统计卡按必填消费）；parity 见 __tests__ */
export interface AuditLogStats {
  totalLogs: number;
  successCount: number;
  failureCount: number;
  topActions: Array<{ action: string; count: number }>;
  topResources: Array<{ resource: string; count: number }>;
  topUsers: Array<{ userId: string; count: number }>;
  dailyStats: Array<{ date: string; count: number }>;
}
export const auditLogStatsSchema = z.object({
  totalLogs: z.number(),
  successCount: z.number(),
  failureCount: z.number(),
  topActions: z.array(z.object({ action: z.string(), count: z.number() })),
  topResources: z.array(z.object({ resource: z.string(), count: z.number() })),
  topUsers: z.array(z.object({ userId: z.string(), count: z.number() })),
  dailyStats: z.array(z.object({ date: z.string(), count: z.number() })),
});

// ── 请求 ──

export const auditLogActorTypeSchema = z.enum(['human', 'agent']);
export const auditLogSourceSchema = z.enum(['operation', 'proposal', 'all']);

/** GET / 查询参数（actorType/source 由任意串透传收紧为词表——唯一消费方前端已在词表内） */
export const auditLogListQuerySchema = z.object({
  userId: z.string().optional(),
  roleId: z.string().optional(),
  companyId: z.string().optional(),
  action: z.string().optional(),
  resource: z.string().optional(),
  resourceId: z.string().optional(),
  status: z.string().optional(),
  anonymousId: z.string().optional(),
  actorType: auditLogActorTypeSchema.optional(),
  source: auditLogSourceSchema.optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  page: z.string().optional(),
  limit: z.string().optional(),
});
export type AuditLogListQuery = z.infer<typeof auditLogListQuerySchema>;

/** 前端查询入参（数值 page/limit；对应 list query 的 wire 串形由 axios 序列化） */
export interface AuditLogQuery {
  action?: string;
  resource?: string;
  status?: string;
  userId?: string;
  actorType?: 'human' | 'agent';
  source?: 'operation' | 'proposal' | 'all';
  startTime?: string;
  endTime?: string;
  page?: number;
  limit?: number;
}

/** GET /stats 查询参数 */
export const auditLogStatsQuerySchema = z.object({
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  userId: z.string().optional(),
  companyId: z.string().optional(),
});
export type AuditLogStatsQuery = z.infer<typeof auditLogStatsQuerySchema>;

/** GET /export 查询参数（过滤口径与列表一致；分页参数无意义不声明） */
export const auditLogExportQuerySchema = auditLogListQuerySchema.omit({ page: true, limit: true });
export type AuditLogExportQuery = z.infer<typeof auditLogExportQuerySchema>;

/** POST / 创建体（AuditLogInput；action/resource 由透传收紧为必填——落库行缺此二键即废行。
 * passthrough：buildRow 只取声明键，额外键透传无意义但历史调用方可能携带，放行不报错） */
export const auditLogCreateBodySchema = z.object({
  userId: z.string().optional(),
  roleId: z.string().optional(),
  companyId: z.string().optional(),
  ipAddress: z.string().optional(),
  userAgent: z.string().optional(),
  action: z.string().min(1),
  resource: z.string().min(1),
  resourceId: z.string().optional(),
  details: z.record(z.unknown()).optional(),
  changes: z.object({
    before: z.record(z.unknown()).optional(),
    after: z.record(z.unknown()).optional(),
    fields: z.array(z.string()).optional(),
  }).optional(),
  status: z.enum(['success', 'partial', 'failure']).optional(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
  sessionId: z.string().optional(),
  requestId: z.string().optional(),
  actorType: auditLogActorTypeSchema.optional(),
}).passthrough();
export type AuditLogCreateBody = z.infer<typeof auditLogCreateBodySchema>;

export const auditLogIdParamsSchema = z.object({ id: z.string().min(1) });

// ── 响应 ──

export const auditLogListResponseSchema = paginatedBodySchema(auditLogRowSchema);
export const auditLogStatsResponseSchema = dataBodySchema(auditLogStatsSchema);
export const auditLogActionsResponseSchema = dataBodySchema(z.array(z.string()));
export const auditLogResourcesResponseSchema = dataBodySchema(z.array(z.string()));
export const auditLogGetResponseSchema = dataBodySchema(auditLogRowSchema);
