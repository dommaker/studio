/**
 * agents 域契约测试：token 聚合 / 请求 schema / 响应壳。
 * 正本 = token-usage.service.ts（AgentTokenUsage）。无消费方实体 z.infer 不手写、无 parity。
 * （legacy CRUD 面 schema 已随 2026-10 架构精简刀2 退役。）
 */

import { describe, it, expect } from 'vitest';
import {
  tokenUsageWindowSchema,
  agentTokenUsageSchema,
  agentTokenUsageParamsSchema,
  agentTokenUsageResponseSchema,
} from '../agents.js';
import * as contractIndex from '../index.js';

const usage = {
  profileId: 'p-1',
  totals: { injectedTokens: 100, executionTokens: 900, totalTokens: 1000 },
  today: { injectedTokens: 10, executionTokens: 90, totalTokens: 100 },
  rolling7d: { injectedTokens: 50, executionTokens: 450, totalTokens: 500 },
  workUnitCount: 3,
  trees: { participated: 2, avgTreeDepth: 4 },
  generatedAt: '2026-09-30T00:00:00.000Z',
};

describe('token usage schema', () => {
  it('窗口三键 + 聚合全形状（空数据全零同形）', () => {
    expect(tokenUsageWindowSchema.parse({ injectedTokens: 0, executionTokens: 0, totalTokens: 0 }))
      .toEqual({ injectedTokens: 0, executionTokens: 0, totalTokens: 0 });
    expect(agentTokenUsageSchema.parse(usage)).toEqual(usage);
    expect(() => agentTokenUsageSchema.parse({ ...usage, workUnitCount: undefined })).toThrow();
    expect(() => agentTokenUsageSchema.parse({ ...usage, trees: { participated: 1 } })).toThrow();
  });
});

describe('请求 schema', () => {
  it('params：id 必填非空', () => {
    expect(agentTokenUsageParamsSchema.parse({ id: 'p-1' })).toEqual({ id: 'p-1' });
    expect(() => agentTokenUsageParamsSchema.parse({ id: '' })).toThrow();
  });
});

describe('响应壳', () => {
  it('token-usage 壳', () => {
    expect(agentTokenUsageResponseSchema.parse({ data: usage }).data.workUnitCount).toBe(3);
  });
});

describe('index.ts 出口', () => {
  it('agents 域 schema 经 index 导出', () => {
    expect(contractIndex.agentTokenUsageSchema).toBeDefined();
    expect(contractIndex.agentTokenUsageResponseSchema).toBeDefined();
  });
});
