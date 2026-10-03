/**
 * triggers 域契约——正本字段以 apps/api/src/modules/triggers/trigger.types.ts
 * （TriggerConfig/TriggerState/TriggerLogEntry）与 trigger.routes.ts 实测 wire 为准。
 *
 * wire 形状（defineRoute 统一壳后）：
 * - 全部端点 `{ data: T }`（原平铺 `{ triggers, schedulerRunning }` / `{ days, ... }` /
 *   `{ fired, wasDisabled, workUnit? }` / 裸 TriggerConfig / `{ ok, id }` / `{ logs }` /
 *   `{ running, triggerCount, logCount }` 统一进壳）
 * - _state.lastFiredAt 与日志 timestamp 为 Date 序列化的 ISO 串
 * - POST / 的 store 校验错误（validateTrigger：缺字段/非法 cron/EVENT 落 store 等）
 *   保持 400（文案不变，经错误映射表）
 */

import { z } from 'zod';
import { dataBodySchema } from './envelope.js';
import { workUnitSchema } from './workunit.js';

// ── 实体：TriggerConfig（= trigger.types.ts）──

export const triggerConditionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('SCHEDULE'), cron: z.string() }),
  z.object({ type: z.literal('EVENT'), event: z.string(), filter: z.record(z.unknown()).optional() }),
]);
export type TriggerConditionWire = z.infer<typeof triggerConditionSchema>;

export const triggerActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('CREATE'),
    target: z.string(),
    payload: z.object({
      type: z.string(),
      scope: z.string(),
      channelId: z.string().optional(),
      metadata: z.record(z.unknown()).optional(),
      assigneeRole: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal('EXECUTE'),
    target: z.string(),
    config: z.record(z.unknown()).optional(),
  }),
  z.object({
    type: z.literal('UPDATE'),
    target: z.string(),
    config: z.object({
      query: z.record(z.unknown()),
      update: z.record(z.unknown()),
    }),
  }),
]);
export type TriggerActionWire = z.infer<typeof triggerActionSchema>;

/**
 * TriggerConfig wire 形状。手写 interface（z.infer 在本仓 strict:false 下退化可选，
 * 判别联合退化后失去 narrowing——后端路由/store 按必填消费）；parity 测试见 __tests__。
 */
export interface TriggerConfigWire {
  id: string;
  name: string;
  condition: TriggerConditionWire;
  action: TriggerActionWire;
  enabled: boolean;
  /** system | user | project */
  scope: string;
}

export const triggerConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  condition: triggerConditionSchema,
  action: triggerActionSchema,
  enabled: z.boolean(),
  scope: z.string().min(1),
});

// ── 派生读形状 ──

/** GET / 列表行：TriggerConfig + 调度器运行时状态（store 与系统默认触发器合并） */
export const triggerWithStateSchema = triggerConfigSchema.extend({
  _state: z.object({
    /** Date 序列化为 ISO 串；未触发过为 null */
    lastFiredAt: z.string().nullable(),
    errorCount: z.number(),
  }),
});
export type TriggerWithState = z.infer<typeof triggerWithStateSchema>;

/** GET / 响应 data */
export const listTriggersResultSchema = z.object({
  triggers: z.array(triggerWithStateSchema),
  schedulerRunning: z.boolean(),
});
export type ListTriggersResult = z.infer<typeof listTriggersResultSchema>;

/** GET /costs 响应 data（byTrigger/bySource 为 token 数；callsBySource 为调用次数） */
export const triggerCostsResultSchema = z.object({
  days: z.number(),
  byTrigger: z.record(z.number()),
  bySource: z.record(z.number()),
  callsBySource: z.record(z.number()),
});
export type TriggerCostsResult = z.infer<typeof triggerCostsResultSchema>;

/** POST /:id/fire 响应 data（CREATE 型带 workUnit；EXECUTE 型没有） */
export const fireTriggerResultSchema = z.object({
  fired: z.boolean(),
  wasDisabled: z.boolean(),
  workUnit: workUnitSchema.optional(),
});
export type FireTriggerResult = z.infer<typeof fireTriggerResultSchema>;

/** POST / 响应 data（创建或更新） */
export const saveTriggerResultSchema = z.object({
  ok: z.boolean(),
  id: z.string(),
});
export type SaveTriggerResult = z.infer<typeof saveTriggerResultSchema>;

/** DELETE /:id 响应 data */
export const deleteTriggerResultSchema = z.object({ ok: z.boolean() });
export type DeleteTriggerResult = z.infer<typeof deleteTriggerResultSchema>;

/** 调度器日志行（timestamp 为 Date 序列化 ISO 串） */
export const triggerLogEntrySchema = z.object({
  timestamp: z.string(),
  triggerId: z.string(),
  event: z.enum(['tick', 'fired', 'error', 'skipped']),
  message: z.string(),
});
export type TriggerLogEntryWire = z.infer<typeof triggerLogEntrySchema>;

/** GET /:id/logs 响应 data */
export const triggerLogsResultSchema = z.object({
  logs: z.array(triggerLogEntrySchema),
});
export type TriggerLogsResult = z.infer<typeof triggerLogsResultSchema>;

/** GET /status 响应 data */
export const triggerStatusResultSchema = z.object({
  running: z.boolean(),
  triggerCount: z.number(),
  logCount: z.number(),
});
export type TriggerStatusResult = z.infer<typeof triggerStatusResultSchema>;

// ── 请求：query / params / body ──

/** GET /costs（days 数字串，handler clamp 1..365 缺省 30） */
export const triggerCostsQuerySchema = z.object({
  days: z.string().optional(),
});
export type TriggerCostsQuery = z.infer<typeof triggerCostsQuerySchema>;

export const triggerIdParamsSchema = z.object({ id: z.string().min(1) });
export type TriggerIdParams = z.infer<typeof triggerIdParamsSchema>;

/**
 * POST / body（创建或更新）。形状校验归 zod；语义校验（非法 cron、EVENT 条件、
 * UPDATE 改 workunit status 等）在 store validateTrigger → 400 映射表（旧行为）。
 */
export const saveTriggerBodySchema = triggerConfigSchema;
export type SaveTriggerBody = z.infer<typeof saveTriggerBodySchema>;

// ── 响应（原平铺/裸对象统一进 `{ data }` 壳）──

export const listTriggersResponseSchema = dataBodySchema(listTriggersResultSchema);
export const triggerCostsResponseSchema = dataBodySchema(triggerCostsResultSchema);
export const triggerResponseSchema = dataBodySchema(triggerConfigSchema);
export const saveTriggerResponseSchema = dataBodySchema(saveTriggerResultSchema);
export const fireTriggerResponseSchema = dataBodySchema(fireTriggerResultSchema);
export const deleteTriggerResponseSchema = dataBodySchema(deleteTriggerResultSchema);
export const triggerLogsResponseSchema = dataBodySchema(triggerLogsResultSchema);
export const triggerStatusResponseSchema = dataBodySchema(triggerStatusResultSchema);
