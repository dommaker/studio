/**
 * mcp 域契约（批次 7/8）——正本以 apps/api/src/modules/mcp/ 的 REST 管理面
 * （routes.ts 的 /tools /tools/:name /health + admin.routes.ts 六端点）实测 wire 为准。
 *
 * **协议面不在 REST 契约范围**（保持原样，不声明）：
 *   POST /api/v1/mcp（JSON-RPC 2.0）、GET /sse、POST /messages、
 *   GET /external/sse、POST /external/messages（#566 D2 外部只读入口）——
 *   SSE transport 与 JSON-RPC 消息面由 MCP 协议定形，envelope 不适用。
 *
 * 端点（route-registry /api/v1/mcp，mcpRateLimit 挂载级）：
 *   GET  /tools                                    列出全部 tools（公开）
 *   POST /tools/:name                              直接调用 tool（requireAuth + requireAdmin）
 *   GET  /health                                   健康检查（unhealthy → 503 裸健康体，例外）
 *   GET  /admin/tools | PATCH /admin/tools/:name   工具管理（requireAuth + requireAdmin）
 *   GET  /admin/stats                              聚合调用统计
 *   GET  /admin/permissions | PUT /admin/permissions  角色×tool 权限
 *   GET  /admin/audit                              调用审计日志
 *
 * wire 形状（defineRoute 统一壳后）：
 * - 列表壳内层 data 键改名词键进壳（避免 data.data 双包，均无消费方，total 保留）：
 *   GET /tools `{ tools, total }` → `{ data: { tools, total } }`；
 *   GET /admin/tools `{ data: [...], total }` → `{ data: { tools, total } }`
 * - 裸对象/平铺 → `{ data }`：POST /tools/:name `{ result, duration }`、
 *   PATCH /admin/tools/:name `{ name, enabled }`、GET /admin/stats 五键、
 *   GET /admin/permissions `{ roleId, permissions }`、PUT /admin/permissions 回显、
 *   GET /admin/audit `{ logs, total }`、GET /health（200 时）
 * - GET /health 的 unhealthy 503 保持裸健康体（`{ status, tools }`，非错误壳）——
 *   机器面健康检查例外，handler 自写 res
 * - POST /tools/:name 抛错由清一色 500 细分：Unknown/disabled tool → 404、
 *   Permission denied → 403、Rate limit → 429，其余 500（code INTERNAL）
 * - 错误统一 `{ error: { code, message } }`：原 `{ error: string|object }` 退役；
 *   500 message 由固定串变为实际错误消息
 */

import { z } from 'zod';
import { dataBodySchema } from './envelope.js';

// ── 实体 ──

/** MCP tool schema（getToolSchemas 投影：name/description/inputSchema 三键） */
export const mcpToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.unknown()),
});
export type McpTool = z.infer<typeof mcpToolSchema>;

/** tool 调用统计（tool-registry ToolStats） */
export const mcpToolStatsSchema = z.object({
  totalCalls: z.number(),
  successCalls: z.number(),
  errorCalls: z.number(),
  lastCallAt: z.number().optional(),
  avgDuration: z.number(),
});
export type McpToolStats = z.infer<typeof mcpToolStatsSchema>;

/** GET /admin/tools 条目（RegisteredTool 投影 + stats，无 stats → null） */
export const mcpAdminToolItemSchema = z.object({
  name: z.string(),
  description: z.string(),
  category: z.string().optional(),
  version: z.string().optional(),
  enabled: z.boolean().optional(),
  requiredPermissions: z.array(z.string()).optional(),
  stats: mcpToolStatsSchema.nullable(),
});
export type McpAdminToolItem = z.infer<typeof mcpAdminToolItemSchema>;

/** GET /health 的 per-tool 健康条目 */
export const mcpHealthToolItemSchema = z.object({
  name: z.string(),
  enabled: z.boolean().optional(),
  errorRate: z.number(),
  lastCallAt: z.number().optional(),
});

/** GET /health 响应 data（200）；unhealthy 503 同形裸出（例外，handler 自写 res） */
export const mcpHealthResultSchema = z.object({
  status: z.enum(['healthy', 'degraded', 'unhealthy']),
  tools: z.array(mcpHealthToolItemSchema),
});
export type McpHealthResult = z.infer<typeof mcpHealthResultSchema>;

/** 审计日志行（permission.service MCPAuditLogRecord；历史行宽声明 passthrough） */
export const mcpAuditLogSchema = z.object({
  id: z.string(),
  toolName: z.string(),
  roleId: z.string().optional(),
  input: z.record(z.unknown()).optional(),
  output: z.unknown().optional(),
  duration: z.number(),
  success: z.boolean(),
  error: z.string().optional(),
  createdAt: z.string(),
}).passthrough();
export type McpAuditLog = z.infer<typeof mcpAuditLogSchema>;

// ── 请求 ──

export const mcpToolNameParamsSchema = z.object({ name: z.string().min(1) });

/** POST /tools/:name：body 即 tool 入参（形状由各 tool 定），passthrough 放行；
 * roleId 为保留键（body.roleId 优先于 x-role-id header） */
export const mcpToolCallBodySchema = z.object({
  roleId: z.string().optional(),
}).passthrough();
export type McpToolCallBody = z.infer<typeof mcpToolCallBodySchema>;

/** PATCH /admin/tools/:name：enabled boolean 必填收进 zod（原手写 400 退役） */
export const mcpToolToggleBodySchema = z.object({
  enabled: z.boolean(),
});
export type McpToolToggleBody = z.infer<typeof mcpToolToggleBodySchema>;

/** GET /admin/permissions：roleId 必填收进 zod（原手写 400 退役） */
export const mcpPermissionsQuerySchema = z.object({
  roleId: z.string().min(1),
});
export type McpPermissionsQuery = z.infer<typeof mcpPermissionsQuerySchema>;

/** PUT /admin/permissions：三件套必填收进 zod（原手写 400 退役） */
export const mcpPermissionSetBodySchema = z.object({
  roleId: z.string().min(1),
  toolName: z.string().min(1),
  allowed: z.boolean(),
});
export type McpPermissionSetBody = z.infer<typeof mcpPermissionSetBodySchema>;

/** GET /admin/audit：success 词表 'true'/'false'（原 `success === 'true'` 吞掉其他值当 undefined 语义收窄） */
export const mcpAuditQuerySchema = z.object({
  toolName: z.string().optional(),
  roleId: z.string().optional(),
  success: z.enum(['true', 'false']).optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
});
export type McpAuditQuery = z.infer<typeof mcpAuditQuerySchema>;

// ── 响应 data ──

export const mcpToolListResultSchema = z.object({
  tools: z.array(mcpToolSchema),
  total: z.number(),
});
export type McpToolListResult = z.infer<typeof mcpToolListResultSchema>;

/** POST /tools/:name 响应 data（result 形状由各 tool 定，unknown） */
export const mcpToolCallResultSchema = z.object({
  result: z.unknown(),
  duration: z.number(),
});
export type McpToolCallResult = z.infer<typeof mcpToolCallResultSchema>;

export const mcpAdminToolListResultSchema = z.object({
  tools: z.array(mcpAdminToolItemSchema),
  total: z.number(),
});
export type McpAdminToolListResult = z.infer<typeof mcpAdminToolListResultSchema>;

export const mcpToolToggleResultSchema = z.object({
  name: z.string(),
  enabled: z.boolean(),
});
export type McpToolToggleResult = z.infer<typeof mcpToolToggleResultSchema>;

export const mcpAdminStatsResultSchema = z.object({
  totalTools: z.number(),
  enabledTools: z.number(),
  totalCalls: z.number(),
  successRate: z.number(),
  byTool: z.record(mcpToolStatsSchema),
});
export type McpAdminStatsResult = z.infer<typeof mcpAdminStatsResultSchema>;

export const mcpRolePermissionsResultSchema = z.object({
  roleId: z.string(),
  permissions: z.array(z.object({
    toolName: z.string(),
    allowed: z.boolean(),
  })),
});
export type McpRolePermissionsResult = z.infer<typeof mcpRolePermissionsResultSchema>;

export const mcpPermissionSetResultSchema = z.object({
  roleId: z.string(),
  toolName: z.string(),
  allowed: z.boolean(),
});
export type McpPermissionSetResult = z.infer<typeof mcpPermissionSetResultSchema>;

export const mcpAuditResultSchema = z.object({
  logs: z.array(mcpAuditLogSchema),
  total: z.number(),
});
export type McpAuditResult = z.infer<typeof mcpAuditResultSchema>;

// ── 响应（统一 `{ data }` 壳）──

export const mcpToolListResponseSchema = dataBodySchema(mcpToolListResultSchema);
export const mcpToolCallResponseSchema = dataBodySchema(mcpToolCallResultSchema);
export const mcpHealthResponseSchema = dataBodySchema(mcpHealthResultSchema);
export const mcpAdminToolListResponseSchema = dataBodySchema(mcpAdminToolListResultSchema);
export const mcpToolToggleResponseSchema = dataBodySchema(mcpToolToggleResultSchema);
export const mcpAdminStatsResponseSchema = dataBodySchema(mcpAdminStatsResultSchema);
export const mcpRolePermissionsResponseSchema = dataBodySchema(mcpRolePermissionsResultSchema);
export const mcpPermissionSetResponseSchema = dataBodySchema(mcpPermissionSetResultSchema);
export const mcpAuditResponseSchema = dataBodySchema(mcpAuditResultSchema);
