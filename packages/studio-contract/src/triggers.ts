/**
 * triggers 域契约——Phase 4 批5（2026-10-17）后只剩两个活端点的 wire 形状：
 *   GET  /triggers/costs      成本聚合（前端 api/maintenance.ts getCosts）
 *   POST /triggers/:id/fire   手动触发（前端 api/maintenance.ts fireTrigger）
 *
 * 原管理面（GET /、GET /status、GET /:id、POST /、DELETE /:id、GET /:id/logs）随
 * 孤儿端点删除整批退役：triggerConfig/condition/action、list/save/delete/logs/status
 * 各 schema 同删。TriggerConfig 正本 = apps/api/src/modules/triggers/trigger.types.ts。
 *
 * wire 形状（defineRoute 统一壳后）：`{ days, ... }` / `{ fired, ... }` 统一进 `{ data }` 壳。
 */

import { z } from 'zod';
import { dataBodySchema } from './envelope.js';

/** GET /costs 响应 data（byTrigger/bySource 为 token 数；callsBySource 为调用次数） */
export const triggerCostsResultSchema = z.object({
  days: z.number(),
  byTrigger: z.record(z.string(), z.number()),
  bySource: z.record(z.string(), z.number()),
  callsBySource: z.record(z.string(), z.number()),
});
export type TriggerCostsResult = z.infer<typeof triggerCostsResultSchema>;

/** POST /:id/fire 响应 data（CREATE 型带 workUnit；EXECUTE 型没有） */
export const fireTriggerResultSchema = z.object({
  fired: z.boolean(),
  wasDisabled: z.boolean(),
  workUnit: z.object({
    id: z.string(),
    type: z.string(),
    scope: z.string(),
    status: z.string(),
    channelId: z.string().nullable(),
    metadata: z.string().nullable(),
  }).optional(),
});
export type FireTriggerResult = z.infer<typeof fireTriggerResultSchema>;

// ── 请求：query / params ──

/** GET /costs（days 数字串，handler clamp 1..365 缺省 30） */
export const triggerCostsQuerySchema = z.object({
  days: z.string().optional(),
});
export type TriggerCostsQuery = z.infer<typeof triggerCostsQuerySchema>;

/** POST /:id/fire 的 params */
export const triggerIdParamsSchema = z.object({ id: z.string().min(1) });
export type TriggerIdParams = z.infer<typeof triggerIdParamsSchema>;

// ── 响应（原平铺统一进 `{ data }` 壳）──

export const triggerCostsResponseSchema = dataBodySchema(triggerCostsResultSchema);
export const fireTriggerResponseSchema = dataBodySchema(fireTriggerResultSchema);
