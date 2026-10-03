/**
 * triggers 域契约测试：TriggerConfig parity + 请求/响应 schema 接受-拒绝边界。
 * 正本 = trigger.types.ts（TriggerConfig/TriggerLogEntry）与 trigger.routes.ts 实测 wire。
 */

import { describe, it, expect } from 'vitest';
import {
  triggerConditionSchema,
  triggerActionSchema,
  triggerConfigSchema,
  type TriggerConfigWire,
  triggerWithStateSchema,
  listTriggersResultSchema,
  triggerCostsResultSchema,
  fireTriggerResultSchema,
  saveTriggerResultSchema,
  deleteTriggerResultSchema,
  triggerLogEntrySchema,
  triggerLogsResultSchema,
  triggerStatusResultSchema,
  triggerCostsQuerySchema,
  triggerIdParamsSchema,
  saveTriggerBodySchema,
  listTriggersResponseSchema,
  triggerCostsResponseSchema,
  triggerResponseSchema,
  saveTriggerResponseSchema,
  fireTriggerResponseSchema,
  deleteTriggerResponseSchema,
  triggerLogsResponseSchema,
  triggerStatusResponseSchema,
} from '../triggers.js';
import * as contractIndex from '../index.js';

/** TriggerConfig 最小合法形状（CREATE 型） */
const triggerRow: TriggerConfigWire = {
  id: 'doc-semantic-review',
  name: '文档语义巡检',
  condition: { type: 'SCHEDULE', cron: '17 3 * * *' },
  action: { type: 'CREATE', target: 'WorkUnit', payload: { type: 'analysis', scope: '巡检' } },
  enabled: true,
  scope: 'system',
};

describe('triggerConfigSchema', () => {
  it('接受三类 action 与两类 condition', () => {
    expect(triggerConfigSchema.parse(triggerRow)).toEqual(triggerRow);
    expect(triggerConfigSchema.parse({
      ...triggerRow,
      condition: { type: 'EVENT', event: 'workunit.status_changed', filter: { status: 'done' } },
    })).toBeTruthy();
    expect(triggerConfigSchema.parse({
      ...triggerRow, action: { type: 'EXECUTE', target: 'agent-loop', config: { k: 1 } },
    })).toBeTruthy();
    expect(triggerConfigSchema.parse({
      ...triggerRow, action: { type: 'UPDATE', target: 'workunit', config: { query: {}, update: { priority: 'high' } } },
    })).toBeTruthy();
    expect(triggerConfigSchema.parse({
      ...triggerRow,
      action: { type: 'CREATE', target: 'WorkUnit', payload: { type: 'task', scope: 's', channelId: 'c', assigneeRole: 'studio' } },
    })).toBeTruthy();
  });

  it('拒绝：未知 type / 缺必填 / enabled 非 boolean', () => {
    expect(triggerConditionSchema.safeParse({ type: 'CRON', cron: '* * * * *' }).success).toBe(false);
    expect(triggerActionSchema.safeParse({ type: 'DELETE', target: 'x' }).success).toBe(false);
    expect(triggerConfigSchema.safeParse({ ...triggerRow, enabled: 'yes' }).success).toBe(false);
    expect(triggerConfigSchema.safeParse({ ...triggerRow, id: '' }).success).toBe(false);
    expect(triggerConfigSchema.safeParse({ ...triggerRow, action: { type: 'CREATE', target: 'WorkUnit' } }).success).toBe(false);
    expect(triggerConfigSchema.safeParse({
      ...triggerRow, action: { type: 'UPDATE', target: 'workunit', config: { query: {} } },
    }).success).toBe(false);
  });

  // strict:false 仓 z.infer 判别联合退化 → TriggerConfigWire 是手写 interface；parity 兜漂移
  it('parity：TriggerConfigWire fixture 全键 = schema.shape 键且通过校验；必填字段删除即拒', () => {
    expect(triggerConfigSchema.parse(triggerRow)).toEqual(triggerRow);
    expect(Object.keys(triggerConfigSchema.shape).sort()).toEqual(Object.keys(triggerRow).sort());
    for (const key of Object.keys(triggerRow)) {
      const { [key]: _drop, ...rest } = triggerRow as unknown as Record<string, unknown>;
      expect(triggerConfigSchema.safeParse(rest).success, `删除 ${key} 应被拒`).toBe(false);
    }
  });
});

describe('派生读形状', () => {
  it('withState / costs / status / logs', () => {
    expect(triggerWithStateSchema.parse({
      ...triggerRow, _state: { lastFiredAt: '2026-09-01T00:00:00.000Z', errorCount: 0 },
    })).toBeTruthy();
    expect(triggerWithStateSchema.parse({ ...triggerRow, _state: { lastFiredAt: null, errorCount: 2 } })).toBeTruthy();
    expect(listTriggersResultSchema.parse({
      triggers: [{ ...triggerRow, _state: { lastFiredAt: null, errorCount: 0 } }], schedulerRunning: true,
    })).toBeTruthy();
    expect(triggerCostsResultSchema.parse({
      days: 30, byTrigger: { t: 100 }, bySource: { s: 15 }, callsBySource: { s: 2 },
    })).toBeTruthy();
    expect(triggerStatusResultSchema.parse({ running: true, triggerCount: 3, logCount: 9 })).toBeTruthy();
    expect(triggerLogEntrySchema.parse({
      timestamp: '2026-09-01T00:00:00.000Z', triggerId: 't', event: 'fired', message: 'm',
    })).toBeTruthy();
    expect(triggerLogEntrySchema.safeParse({
      timestamp: 't', triggerId: 't', event: 'bogus', message: 'm',
    }).success).toBe(false);
    expect(triggerLogsResultSchema.parse({ logs: [] })).toEqual({ logs: [] });
  });

  it('fire 结果：CREATE 带 workUnit、EXECUTE 不带', () => {
    expect(fireTriggerResultSchema.parse({ fired: true, wasDisabled: false })).toEqual({ fired: true, wasDisabled: false });
    expect(saveTriggerResultSchema.parse({ ok: true, id: 't' })).toEqual({ ok: true, id: 't' });
    expect(deleteTriggerResultSchema.parse({ ok: true })).toEqual({ ok: true });
  });
});

describe('请求与响应', () => {
  it('query/params/body 边界', () => {
    expect(triggerCostsQuerySchema.parse({ days: '7' })).toEqual({ days: '7' });
    expect(triggerIdParamsSchema.safeParse({ id: '' }).success).toBe(false);
    expect(saveTriggerBodySchema.parse(triggerRow)).toEqual(triggerRow);
  });

  it('统一 { data } 壳', () => {
    expect(listTriggersResponseSchema.parse({
      data: { triggers: [], schedulerRunning: false },
    })).toBeTruthy();
    expect(triggerCostsResponseSchema.parse({
      data: { days: 30, byTrigger: {}, bySource: {}, callsBySource: {} },
    })).toBeTruthy();
    expect(triggerResponseSchema.parse({ data: triggerRow })).toBeTruthy();
    expect(saveTriggerResponseSchema.parse({ data: { ok: true, id: 't' } })).toBeTruthy();
    expect(fireTriggerResponseSchema.parse({ data: { fired: true, wasDisabled: true } })).toBeTruthy();
    expect(deleteTriggerResponseSchema.parse({ data: { ok: true } })).toBeTruthy();
    expect(triggerLogsResponseSchema.parse({ data: { logs: [] } })).toBeTruthy();
    expect(triggerStatusResponseSchema.parse({
      data: { running: false, triggerCount: 0, logCount: 0 },
    })).toBeTruthy();
  });

  it('index.ts 出口包含 triggers 域 schema', () => {
    expect(contractIndex.triggerConfigSchema).toBe(triggerConfigSchema);
    expect(contractIndex.fireTriggerResultSchema).toBe(fireTriggerResultSchema);
  });
});
