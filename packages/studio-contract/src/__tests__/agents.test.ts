/**
 * agents 域契约测试：legacy AgentMetadata / token 聚合 / 请求 schema / 响应壳。
 * 正本 = apps/api/src/modules/agents/routes.ts（LEGACY surface）
 * + token-usage.service.ts（AgentTokenUsage）。无消费方实体 z.infer 不手写、无 parity。
 */

import { describe, it, expect } from 'vitest';
import {
  legacyAgentMetadataSchema,
  legacyAgentListQuerySchema,
  legacyAgentRegisterBodySchema,
  legacyAgentUpdateBodySchema,
  legacyAgentIdParamsSchema,
  legacyAgentVersionQuerySchema,
  tokenUsageWindowSchema,
  agentTokenUsageSchema,
  agentTokenUsageParamsSchema,
  legacyAgentListResponseSchema,
  legacyAgentResponseSchema,
  agentTokenUsageResponseSchema,
} from '../agents.js';
import * as contractIndex from '../index.js';

const metadata = {
  id: 'a-1',
  name: 'legacy-agent',
  version: '1.0.0',
  category: 'llm',
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  configSchema: { type: 'object' },
};

const usage = {
  profileId: 'p-1',
  totals: { injectedTokens: 100, executionTokens: 900, totalTokens: 1000 },
  today: { injectedTokens: 10, executionTokens: 90, totalTokens: 100 },
  rolling7d: { injectedTokens: 50, executionTokens: 450, totalTokens: 500 },
  workUnitCount: 3,
  trees: { participated: 2, avgTreeDepth: 4 },
  generatedAt: '2026-09-30T00:00:00.000Z',
};

describe('legacyAgentMetadataSchema', () => {
  it('核心必填（id/name/version/category/三 schema）+ 可选字段 + passthrough 扩展键', () => {
    expect(legacyAgentMetadataSchema.parse(metadata)).toEqual(metadata);
    const full = {
      ...metadata,
      description: 'd',
      icon: 'i',
      tags: ['t1'],
      endpoint: 'http://x',
      timeout: 3000,
      retryPolicy: { maxRetries: 3, backoff: 'fixed', initialDelay: 100, maxDelay: 1000 },
      rateLimit: { requests: 10, windowMs: 1000 },
      metadata: { k: 'v' },
      createdAt: '2026-01-01T00:00:00.000Z',
      futureField: 'passthrough',
    };
    expect(legacyAgentMetadataSchema.parse(full)).toEqual(full);
    expect(() => legacyAgentMetadataSchema.parse({ ...metadata, id: undefined })).toThrow();
    expect(() => legacyAgentMetadataSchema.parse({ ...metadata, category: 'robot' })).toThrow();
  });
});

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
  it('list query：category/tags/page/limit 全可选字符串', () => {
    expect(legacyAgentListQuerySchema.parse({})).toEqual({});
    expect(legacyAgentListQuerySchema.parse({ tags: 'a,b', page: '2' })).toEqual({ tags: 'a,b', page: '2' });
  });

  it('register/update body：已知键可选 + passthrough 全透传（字段集归 registry 自持）', () => {
    const body = { name: 'x', version: '1.0.0', unknownKey: { nested: true } };
    expect(legacyAgentRegisterBodySchema.parse(body)).toEqual(body);
    expect(legacyAgentUpdateBodySchema.parse(body)).toEqual(body);
    expect(legacyAgentUpdateBodySchema.parse({})).toEqual({});
  });

  it('params/version query：agentId 必填非空；version 可选（必填判在 handler 保 VERSION_REQUIRED code）', () => {
    expect(legacyAgentIdParamsSchema.parse({ agentId: 'a-1' })).toEqual({ agentId: 'a-1' });
    expect(() => legacyAgentIdParamsSchema.parse({ agentId: '' })).toThrow();
    expect(legacyAgentVersionQuerySchema.parse({})).toEqual({});
    expect(legacyAgentVersionQuerySchema.parse({ version: '1.0.0' })).toEqual({ version: '1.0.0' });
    expect(agentTokenUsageParamsSchema.parse({ id: 'p-1' })).toEqual({ id: 'p-1' });
  });
});

describe('响应壳', () => {
  it('legacy 分页壳 / 单实体壳 / token-usage 壳', () => {
    const page = { data: [metadata], pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } };
    expect(legacyAgentListResponseSchema.parse(page)).toEqual(page);
    expect(legacyAgentResponseSchema.parse({ data: metadata }).data.name).toBe('legacy-agent');
    expect(agentTokenUsageResponseSchema.parse({ data: usage }).data.workUnitCount).toBe(3);
  });
});

describe('index.ts 出口', () => {
  it('agents 域 schema 经 index 导出', () => {
    expect(contractIndex.legacyAgentMetadataSchema).toBeDefined();
    expect(contractIndex.legacyAgentListResponseSchema).toBeDefined();
    expect(contractIndex.agentTokenUsageSchema).toBeDefined();
    expect(contractIndex.agentTokenUsageResponseSchema).toBeDefined();
  });
});
