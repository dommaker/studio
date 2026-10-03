/**
 * executions 域契约测试（LEGACY surface）：请求边界 + 响应壳。
 * 正本 = apps/api/src/modules/executions/routes.ts。
 */

import { describe, it, expect } from 'vitest';
import {
  executionWithProgressSchema,
  executionListQuerySchema,
  executionEventBodySchema,
  executionListResponseSchema,
  executionGetResponseSchema,
  executionEventResponseSchema,
} from '../executions.js';
import * as contractIndex from '../index.js';

describe('实体', () => {
  it('历史行稀疏 passthrough 放行扩展键；进度三键必填', () => {
    const row = {
      id: 'e1', status: 'running', createdAt: '2026-09-01T00:00:00.000Z',
      parameters: '{"x":1}', currentStep: 2, totalSteps: 5, progress: 40,
    };
    const parsed = executionWithProgressSchema.parse(row);
    expect(parsed.progress).toBe(40);
    expect((parsed as Record<string, unknown>).parameters).toBe('{"x":1}');
    expect(() => executionWithProgressSchema.parse({ id: 'e1' })).toThrow();
  });
});

describe('请求边界', () => {
  it('GET /：status/page/limit 全可选字符串', () => {
    expect(executionListQuerySchema.parse({ status: 'failed', page: '2', limit: '50' }).page).toBe('2');
    expect(executionListQuerySchema.parse({})).toEqual({});
  });

  it('POST /events：runtime 事件体 passthrough，字段全可选', () => {
    const ev = { type: 'workflow.completed', executionId: 'r-1', outputs: { a: 1 }, extraKey: true };
    const parsed = executionEventBodySchema.parse(ev);
    expect(parsed.type).toBe('workflow.completed');
    expect((parsed as Record<string, unknown>).extraKey).toBe(true);
    expect(executionEventBodySchema.parse({})).toEqual({});
  });
});

describe('响应壳', () => {
  it('GET / → 分页壳 { data: [...], pagination }（形状不变）', () => {
    const body = {
      data: [{ currentStep: 0, totalSteps: 0, progress: 0 }],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    };
    expect(executionListResponseSchema.parse(body).pagination.total).toBe(1);
  });

  it('GET /:executionId → { data: execution }（裸实体进壳）', () => {
    const body = { data: { currentStep: 1, totalSteps: 3, progress: 33 } };
    expect(executionGetResponseSchema.parse(body).data.currentStep).toBe(1);
  });

  it('POST /events → { data: { received: true } }', () => {
    expect(executionEventResponseSchema.parse({ data: { received: true } }).data.received).toBe(true);
  });
});

describe('index.ts 出口', () => {
  it('executions 域 schema 经 index 导出', () => {
    expect(contractIndex.executionEventBodySchema).toBeDefined();
    expect(contractIndex.executionListResponseSchema).toBeDefined();
  });
});
