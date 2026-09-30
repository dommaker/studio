/**
 * builtin-tools 域契约（批次 7/8）——正本以 apps/api/src/modules/builtin-tools/
 * routes.ts 实测 wire 为准。工具列表静态注册（HZ-026），无 service 层。
 *
 * 端点（route-registry /api/v1/builtin-tools 挂 admin）：
 *   GET   /          工具列表（category 过滤）
 *   GET   /:name     单个工具详情
 *   PATCH /:name     启用/禁用
 *
 * wire 形状（defineRoute 统一壳后）：
 * - GET / 列表壳内层 data 键改名词键进壳（避免 data.data 双包，无消费方）：
 *   `{ data: [...], total, categories }` → `{ data: { tools, total, categories } }`
 * - GET /:name 与 PATCH /:name 裸实体 → `{ data: tool }`
 * - PATCH 非 boolean enabled 由静默忽略（200 原样）收紧为 400（zod）
 * - 404 `{ error: 'Tool not found' }` → `{ error: { code: NOT_FOUND, message } }`；
 *   500 message 由固定串变为实际错误消息
 */

import { z } from 'zod';
import { dataBodySchema } from './envelope.js';

/** 内置工具元数据（静态注册，HZ-026） */
export const builtinToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  category: z.enum(['file', 'search', 'execution', 'communication']),
  inputSchema: z.record(z.unknown()),
  enabled: z.boolean(),
});
export type BuiltinTool = z.infer<typeof builtinToolSchema>;

export const builtinToolNameParamsSchema = z.object({ name: z.string().min(1) });

/** GET /：category 过滤为自由串（词表外值 → 空列表，原语义保留） */
export const builtinToolListQuerySchema = z.object({
  category: z.string().optional(),
});
export type BuiltinToolListQuery = z.infer<typeof builtinToolListQuerySchema>;

/** PATCH /:name：非 boolean enabled 由静默忽略收紧为 400 */
export const builtinToolPatchBodySchema = z.object({
  enabled: z.boolean().optional(),
});
export type BuiltinToolPatchBody = z.infer<typeof builtinToolPatchBodySchema>;

/** GET / 响应 data */
export const builtinToolListResultSchema = z.object({
  tools: z.array(builtinToolSchema),
  total: z.number(),
  categories: z.array(z.string()),
});
export type BuiltinToolListResult = z.infer<typeof builtinToolListResultSchema>;

export const builtinToolListResponseSchema = dataBodySchema(builtinToolListResultSchema);
export const builtinToolGetResponseSchema = dataBodySchema(builtinToolSchema);
export const builtinToolPatchResponseSchema = dataBodySchema(builtinToolSchema);
