/**
 * evolution 域契约测试：EvolutionProposal parity + 请求/响应 schema 接受-拒绝边界。
 * 正本 = studio-shared file-store-types.ts EvolutionProposalData、generator.ts
 * GenerationResult、constraint-adapter.ts ConstraintProposal/ConstraintScanResult。
 */

import { describe, it, expect } from 'vitest';
import {
  evolutionTargetTypeSchema,
  evolutionProposalStatusSchema,
  evolutionEvidenceSchema,
  evolutionProposalSchema,
  type EvolutionProposal,
  constraintProposalSchema,
  constraintScanResultSchema,
  evolutionRunResultSchema,
  listEvolutionProposalsQuerySchema,
  evolutionProposalIdParamsSchema,
  decideEvolutionBodySchema,
  evolutionProposalListResponseSchema,
  evolutionProposalResponseSchema,
  evolutionRunResponseSchema,
} from '../evolution.js';
import * as contractIndex from '../index.js';

/** EvolutionProposalData 最小合法形状（pending 提案） */
const proposalRow: EvolutionProposal = {
  id: 'EP-0001',
  seq: 1,
  targetType: 'prompt-template',
  targetId: 'knowledge.rules-section',
  action: 'amend',
  currentText: '## 系统约束\n{content}',
  proposedText: '## 系统约束（强制）\n{content}',
  rationale: '窗口内任务失败率高',
  evidence: { windowHours: 24, eventCounts: { outcomes: 8, failures: 6 } },
  status: 'pending',
  source: 'heuristic:prompt-failure',
  createdAt: '2026-09-01T00:00:00.000Z',
};

describe('evolutionProposalSchema', () => {
  it('接受全生命周期状态与决策字段', () => {
    expect(evolutionProposalSchema.parse(proposalRow)).toEqual(proposalRow);
    expect(evolutionProposalSchema.parse({
      ...proposalRow,
      status: 'applied',
      decidedBy: 'api:local',
      decidedAt: '2026-09-02T00:00:00.000Z',
      appliedAt: '2026-09-02T00:01:00.000Z',
    })).toBeTruthy();
    expect(evolutionProposalSchema.parse({
      ...proposalRow, status: 'stale', staledAt: '2026-09-15T00:00:00.000Z',
    })).toBeTruthy();
    expect(evolutionProposalSchema.parse({
      ...proposalRow,
      targetType: 'iron-law',
      action: 'add',
      constraintChange: 'retire',
      evidence: { windowHours: 24, eventCounts: {}, samples: ['s1'] },
    })).toBeTruthy();
  });

  it('词表：targetType/status/action/constraintChange', () => {
    expect(evolutionTargetTypeSchema.safeParse('bogus').success).toBe(false);
    expect(evolutionProposalStatusSchema.safeParse('executed').success).toBe(false);
    expect(evolutionProposalSchema.safeParse({ ...proposalRow, action: 'delete' }).success).toBe(false);
    expect(evolutionProposalSchema.safeParse({ ...proposalRow, constraintChange: 'message' }).success).toBe(false);
    expect(evolutionEvidenceSchema.safeParse({ windowHours: 24 }).success).toBe(false);
  });

  // strict:false 仓 z.infer 全字段退化可选 → EvolutionProposal 是手写 interface；parity 兜漂移
  it('parity：EvolutionProposal fixture 全键 = schema.shape 键且通过校验；必填字段删除即拒', () => {
    const full: EvolutionProposal = {
      ...proposalRow,
      constraintChange: 'disable',
      decidedBy: 'api:local',
      decidedAt: '2026-09-02T00:00:00.000Z',
      appliedAt: null,
      rejectReason: null,
      staledAt: null,
    };
    expect(evolutionProposalSchema.parse(full)).toEqual(full);
    expect(Object.keys(evolutionProposalSchema.shape).sort()).toEqual(Object.keys(full).sort());
    for (const key of Object.keys(proposalRow)) {
      const { [key]: _drop, ...rest } = proposalRow as unknown as Record<string, unknown>;
      expect(evolutionProposalSchema.safeParse(rest).success, `删除 ${key} 应被拒`).toBe(false);
    }
  });
});

describe('runScan 结果', () => {
  const constraintProposalRow = {
    id: 'cp-1',
    createdAt: '2026-09-01T00:00:00.000Z',
    action: 'new',
    repoRoot: '/repo',
    constraintId: 'app_no_foo',
    rule: '禁止 foo',
    checker: 'regex-scan',
    params: { pattern: 'foo' },
    severity: 'error',
    message: '发现 foo',
    sourceEntry: { id: 'k1', title: 't' },
  };

  it('constraint 提案与扫描结果', () => {
    expect(constraintProposalSchema.parse(constraintProposalRow)).toEqual(constraintProposalRow);
    expect(constraintProposalSchema.parse({
      ...constraintProposalRow, checker: null, sourceEntry: undefined, statsText: '累计评估 60 次',
    })).toBeTruthy();
    expect(constraintProposalSchema.safeParse({ ...constraintProposalRow, action: 'bogus' }).success).toBe(false);
    expect(constraintScanResultSchema.parse({ created: [constraintProposalRow], skipped: {}, posted: 1 })).toBeTruthy();
  });

  it('run 结果：created/skipped/staled/scanned/posted + 可选 constraintScan', () => {
    const runRow = {
      created: [proposalRow],
      skipped: { duplicate: 1 },
      staled: ['EP-0000'],
      scanned: { constraintTraces: 1, toolCalls: 2, outcomes: 8, incidents: 0 },
      posted: 1,
    };
    expect(evolutionRunResultSchema.parse(runRow)).toEqual(runRow);
    expect(evolutionRunResultSchema.parse({
      ...runRow, constraintScan: { created: [], skipped: {}, posted: 0 },
    })).toBeTruthy();
    expect(evolutionRunResultSchema.safeParse({ ...runRow, posted: undefined }).success).toBe(false);
  });
});

describe('请求与响应', () => {
  it('query/params/body 边界', () => {
    expect(listEvolutionProposalsQuerySchema.parse({ status: 'pending', targetType: 'role-preset' }))
      .toEqual({ status: 'pending', targetType: 'role-preset' });
    expect(listEvolutionProposalsQuerySchema.parse({})).toEqual({});
    expect(evolutionProposalIdParamsSchema.safeParse({ id: '' }).success).toBe(false);
    expect(decideEvolutionBodySchema.parse({})).toEqual({});
    expect(decideEvolutionBodySchema.parse({ reason: 'r', decidedBy: 'api:u' })).toEqual({ reason: 'r', decidedBy: 'api:u' });
    expect(decideEvolutionBodySchema.safeParse({ reason: 1 }).success).toBe(false);
  });

  it('统一 { data } 壳（原 { success, data } 退役）', () => {
    expect(evolutionProposalListResponseSchema.parse({ data: [proposalRow] })).toBeTruthy();
    expect(evolutionProposalResponseSchema.parse({ data: proposalRow })).toBeTruthy();
    expect(evolutionRunResponseSchema.parse({
      data: {
        created: [], skipped: {}, staled: [],
        scanned: { constraintTraces: 0, toolCalls: 0, outcomes: 0, incidents: 0 }, posted: 0,
      },
    })).toBeTruthy();
  });

  it('index.ts 出口包含 evolution 域 schema', () => {
    expect(contractIndex.evolutionProposalSchema).toBe(evolutionProposalSchema);
    expect(contractIndex.evolutionRunResultSchema).toBe(evolutionRunResultSchema);
  });
});
