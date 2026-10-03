/**
 * specs 域契约测试：请求/响应 schema 的接受-拒绝边界。
 * 正本 = packages/studio-spec types（AnalyzeChangeResult/ChangeRecord/GatePolicy 等）。
 * 实体均为后端产出、无前端消费方 → z.infer 直接使用，无手写 interface parity。
 */

import { describe, it, expect } from 'vitest';
import {
  changeLevelSchema,
  specContentSchema,
  approvalProcessSchema,
  changeDetailSchema,
  analyzeChangeResultSchema,
  changeRecordSchema,
  changeStatsSchema,
  checkResultSchema,
  validateChangeResultSchema,
  gatePolicySchema,
  importChangesResultSchema,
  specIdParamsSchema,
  changeIdParamsSchema,
  gateLevelParamsSchema,
  listSpecChangesQuerySchema,
  analyzeChangeBodySchema,
  validateChangeBodySchema,
  importChangesBodySchema,
  analyzeChangeResponseSchema,
  changeRecordResponseSchema,
  validateChangeResponseSchema,
  gatePolicyResponseSchema,
  gatePolicyMapResponseSchema,
  specChangeListResponseSchema,
  changeStatsResponseSchema,
  importChangesResponseSchema,
} from '../specs.js';
import * as contractIndex from '../index.js';

const specContentRow = {
  metadata: { id: 'spec-1', title: 'T', status: 'draft' },
  acceptance_criteria: [{ id: 'AC-1', description: 'd', passes: true }],
};

const changeRecordRow = {
  id: 'chg-1',
  specId: 'spec-1',
  level: 'L2',
  changeTypes: ['param_adjust'],
  summary: 's',
  status: 'pending',
  submittedBy: 'user-1',
  submittedAt: '2026-09-01T00:00:00.000Z',
  oldVersion: specContentRow,
  newVersion: specContentRow,
};

const analyzeResultRow = {
  level: 'L3',
  changeTypes: ['api_change'],
  affectedAreas: ['api'],
  riskScore: 42,
  recommendedApproval: { type: 'single_approval', description: 'd', estimatedTime: '1h' },
  summary: 's',
  changes: [{ type: 'api_change', area: 'api', description: 'd' }],
};

const gatePolicyRow = {
  level: 'L2',
  checkpoints: ['spec_format'],
  autoApprove: false,
  requiresHumanReview: true,
  description: 'd',
};

describe('实体 schema', () => {
  it('changeLevel 词表', () => {
    expect(changeLevelSchema.parse('L1')).toBe('L1');
    expect(changeLevelSchema.safeParse('L5').success).toBe(false);
  });

  it('specContent：metadata.id 必填，其余 passthrough', () => {
    expect(specContentSchema.parse(specContentRow)).toEqual(specContentRow);
    expect(specContentSchema.safeParse({}).success).toBe(false);
    expect(specContentSchema.parse({ metadata: { id: 'x', extra: 1 }, custom: 'y' })).toBeTruthy();
  });

  it('analyzeChangeResult / changeRecord / gatePolicy', () => {
    expect(analyzeChangeResultSchema.parse(analyzeResultRow)).toEqual(analyzeResultRow);
    expect(analyzeChangeResultSchema.safeParse({ ...analyzeResultRow, level: 'L9' }).success).toBe(false);
    expect(approvalProcessSchema.safeParse({ type: 'bogus', description: 'd', estimatedTime: 't' }).success).toBe(false);
    expect(changeDetailSchema.parse({ type: 'typo_fix', area: 'doc', description: 'd', oldValue: 1 })).toBeTruthy();

    expect(changeRecordSchema.parse(changeRecordRow)).toEqual(changeRecordRow);
    expect(changeRecordSchema.parse({
      ...changeRecordRow, status: 'applied', approvedBy: 'u', approvedAt: 't', appliedAt: 't', approvers: ['a'],
    })).toBeTruthy();
    expect(changeRecordSchema.safeParse({ ...changeRecordRow, status: 'bogus' }).success).toBe(false);
    expect(changeRecordSchema.safeParse({ ...changeRecordRow, submittedAt: undefined }).success).toBe(false);

    expect(gatePolicySchema.parse(gatePolicyRow)).toEqual(gatePolicyRow);
    expect(gatePolicySchema.safeParse({ ...gatePolicyRow, autoApprove: 'yes' }).success).toBe(false);
  });

  it('validate 结果与 stats', () => {
    const check = { type: 'spec_format', passed: true, message: 'ok' };
    expect(checkResultSchema.parse({ ...check, details: { k: 1 } })).toBeTruthy();
    expect(validateChangeResultSchema.parse({
      changeId: 'chg-1', level: 'L2', passed: true, checks: [check], summary: 's', canProceed: true,
    })).toBeTruthy();
    expect(changeStatsSchema.parse({
      total: 1,
      byLevel: { L1: 0, L2: 1, L3: 0, L4: 0 },
      byStatus: { pending: 1 },
      recentChanges: [changeRecordRow],
    })).toBeTruthy();
    expect(importChangesResultSchema.parse({ imported: 3 })).toEqual({ imported: 3 });
  });
});

describe('请求 schema', () => {
  it('params/query 边界（level 非法原 200 空体 → zod 400）', () => {
    expect(specIdParamsSchema.safeParse({ id: '' }).success).toBe(false);
    expect(changeIdParamsSchema.safeParse({ changeId: '' }).success).toBe(false);
    expect(gateLevelParamsSchema.parse({ level: 'L4' })).toEqual({ level: 'L4' });
    expect(gateLevelParamsSchema.safeParse({ level: 'L9' }).success).toBe(false);
    expect(listSpecChangesQuerySchema.parse({ page: '2', limit: '50' })).toEqual({ page: '2', limit: '50' });
  });

  it('analyze body：oldVersion/newVersion 必填（原手写 Missing guard）', () => {
    expect(analyzeChangeBodySchema.parse({ oldVersion: specContentRow, newVersion: specContentRow })).toBeTruthy();
    expect(analyzeChangeBodySchema.safeParse({ oldVersion: specContentRow }).success).toBe(false);
    expect(analyzeChangeBodySchema.safeParse({}).success).toBe(false);
  });

  it('validate/import body', () => {
    expect(validateChangeBodySchema.parse({})).toEqual({});
    expect(validateChangeBodySchema.parse({
      checkpoints: ['file_exists'], harnessConfigs: [{ type: 'file_exists', harness: { path: 'x' } }], strictMode: true,
    })).toBeTruthy();
    expect(validateChangeBodySchema.safeParse({ checkpoints: 'x' }).success).toBe(false);
    expect(importChangesBodySchema.parse({ data: '[]' })).toEqual({ data: '[]' });
    expect(importChangesBodySchema.safeParse({}).success).toBe(false);
  });
});

describe('响应 schema（{ data } / 分页壳）', () => {
  it('统一壳', () => {
    expect(analyzeChangeResponseSchema.parse({ data: analyzeResultRow })).toBeTruthy();
    expect(changeRecordResponseSchema.parse({ data: changeRecordRow })).toBeTruthy();
    expect(validateChangeResponseSchema.parse({
      data: { changeId: 'c', level: 'L1', passed: true, checks: [], summary: 's', canProceed: true },
    })).toBeTruthy();
    expect(gatePolicyResponseSchema.parse({ data: gatePolicyRow })).toBeTruthy();
    expect(gatePolicyMapResponseSchema.parse({ data: { L2: gatePolicyRow } })).toBeTruthy();
    expect(specChangeListResponseSchema.parse({
      data: [changeRecordRow],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    })).toBeTruthy();
    expect(changeStatsResponseSchema.parse({
      data: { total: 0, byLevel: { L1: 0, L2: 0, L3: 0, L4: 0 }, byStatus: {}, recentChanges: [] },
    })).toBeTruthy();
    expect(importChangesResponseSchema.parse({ data: { imported: 1 } })).toBeTruthy();
  });

  it('index.ts 出口包含 specs 域 schema', () => {
    expect(contractIndex.specContentSchema).toBe(specContentSchema);
    expect(contractIndex.analyzeChangeResultSchema).toBe(analyzeChangeResultSchema);
    expect(contractIndex.gatePolicySchema).toBe(gatePolicySchema);
  });
});
