/**
 * triggers 域契约测试（Phase 4 批5 后）：只剩 costs + fire 两个活端点的 wire 形状。
 * schema 即正本；同名类型为 z.infer alias，由编译期断言锚定，无 parity 互验层。
 */

import { describe, it, expect } from 'vitest';
import {
  triggerCostsResultSchema,
  fireTriggerResultSchema,
  triggerCostsQuerySchema,
  triggerIdParamsSchema,
  triggerCostsResponseSchema,
  fireTriggerResponseSchema,
} from '../triggers.js';
import * as contractIndex from '../index.js';

describe('派生读形状', () => {
  it('costs 聚合四键', () => {
    expect(triggerCostsResultSchema.parse({
      days: 30, byTrigger: { t: 100 }, bySource: { s: 15 }, callsBySource: { s: 2 },
    })).toBeTruthy();
  });

  it('fire 结果：CREATE 带 executeCreateAction 的 WU 摘要、EXECUTE 不带', () => {
    expect(fireTriggerResultSchema.parse({ fired: true, wasDisabled: false })).toEqual({ fired: true, wasDisabled: false });
    const workUnit = { id: 'w1', type: 'task', scope: 's', status: 'pending', channelId: null, metadata: null };
    expect(fireTriggerResultSchema.parse({ fired: true, wasDisabled: false, workUnit }).workUnit).toEqual(workUnit);
  });
});

describe('请求与响应', () => {
  it('query/params 边界', () => {
    expect(triggerCostsQuerySchema.parse({ days: '7' })).toEqual({ days: '7' });
    expect(triggerCostsQuerySchema.parse({})).toEqual({});
    expect(triggerIdParamsSchema.parse({ id: 't' })).toEqual({ id: 't' });
    expect(triggerIdParamsSchema.safeParse({ id: '' }).success).toBe(false);
  });

  it('统一 { data } 壳', () => {
    expect(triggerCostsResponseSchema.parse({
      data: { days: 30, byTrigger: {}, bySource: {}, callsBySource: {} },
    })).toBeTruthy();
    expect(fireTriggerResponseSchema.parse({ data: { fired: true, wasDisabled: true } })).toBeTruthy();
  });

  it('index.ts 出口包含 triggers 域 schema', () => {
    expect(contractIndex.triggerCostsResultSchema).toBe(triggerCostsResultSchema);
    expect(contractIndex.fireTriggerResultSchema).toBe(fireTriggerResultSchema);
  });
});
