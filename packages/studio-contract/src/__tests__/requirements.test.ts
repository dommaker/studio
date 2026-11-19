/**
 * requirements 域契约测试：实体/请求/响应 schema 的接受-拒绝边界 +
 * 与后端 wire 行为对齐的关键形状（正本 = requirement.service.ts RequirementWithProject + 路由实测）。
 */

import { describe, it, expect } from 'vitest';
import {
  requirementSchema,
  type Requirement,
  requirementStatusSchema,
  requirementChainWorkUnitSchema,
  chainStatEntrySchema,
  requirementChainSchema,
  listRequirementsQuerySchema,
  chainStatsQuerySchema,
  requirementIdParamsSchema,
  createRequirementBodySchema,
  updateRequirementBodySchema,
  requirementListResponseSchema,
  requirementResponseSchema,
  requirementChainResponseSchema,
  chainStatsResultSchema,
  chainStatsResponseSchema,
} from '../requirements.js';
import * as contractIndex from '../index.js';

/** 后端 RequirementWithProject 全字段形状（类型 = z.infer 同源，编译期锚定） */
const reqRow: Requirement = {
  id: 'REQ-0001',
  seq: 1,
  title: '手动需求',
  status: 'open',
  createdAt: '2026-09-01T00:00:00.000Z',
  createdBy: 'manual',
};

describe('requirementSchema', () => {
  it('接受后端 wire 形状（含可选项/别名视图 projectId）', () => {
    expect(requirementSchema.parse(reqRow)).toEqual(reqRow);
    const full = {
      ...reqRow, channelId: 'ch-1', docs: ['a.md'], description: 'd', projectId: 'proj-1',
    };
    expect(requirementSchema.parse(full)).toEqual(full);
    expect(requirementSchema.parse({ ...reqRow, channelId: null, projectId: null })).toBeTruthy();
  });

  it('status 词表外 → 拒绝', () => {
    expect(requirementSchema.safeParse({ ...reqRow, status: 'bogus' }).success).toBe(false);
    for (const s of ['open', 'in-progress', 'done', 'archived'] as const) {
      expect(requirementStatusSchema.parse(s)).toBe(s);
    }
  });
});

describe('请求 schema', () => {
  it('list query：status 枚举校验（非法 → 400，替代手写 includes 守卫）', () => {
    expect(listRequirementsQuerySchema.parse({})).toEqual({});
    expect(listRequirementsQuerySchema.parse({ status: 'done', channelId: 'ch-1' }))
      .toEqual({ status: 'done', channelId: 'ch-1' });
    expect(listRequirementsQuerySchema.safeParse({ status: 'bogus' }).success).toBe(false);
  });

  it('chain-stats query：reqIds 必填且含非空白段（全空白段视同缺失）', () => {
    expect(chainStatsQuerySchema.parse({ reqIds: 'REQ-1,REQ-2' })).toEqual({ reqIds: 'REQ-1,REQ-2' });
    expect(chainStatsQuerySchema.safeParse({}).success).toBe(false);
    expect(chainStatsQuerySchema.safeParse({ reqIds: '' }).success).toBe(false);
    expect(chainStatsQuerySchema.safeParse({ reqIds: ' , ,' }).success).toBe(false);
  });

  it('create body：title trim 必填；docs 字符串数组；projectId string|null', () => {
    expect(createRequirementBodySchema.parse({ title: ' x ' })).toEqual({ title: 'x' });
    expect(createRequirementBodySchema.safeParse({}).success).toBe(false);
    expect(createRequirementBodySchema.safeParse({ title: '  ' }).success).toBe(false);
    expect(createRequirementBodySchema.safeParse({ title: 'x', docs: ['ok', 1] }).success).toBe(false);
    expect(createRequirementBodySchema.parse({ title: 'x', projectId: null }).projectId).toBeNull();
    expect(createRequirementBodySchema.safeParse({ title: 'x', projectId: 123 }).success).toBe(false);
  });

  it('update body：全可选；title 空白拒绝；status 枚举', () => {
    expect(updateRequirementBodySchema.parse({})).toEqual({});
    expect(updateRequirementBodySchema.safeParse({ title: '  ' }).success).toBe(false);
    expect(updateRequirementBodySchema.safeParse({ status: 'bogus' }).success).toBe(false);
    expect(updateRequirementBodySchema.parse({ status: 'done', projectId: null })).toEqual({ status: 'done', projectId: null });
    expect(requirementIdParamsSchema.safeParse({ id: '' }).success).toBe(false);
  });
});

describe('链路与响应 schema', () => {
  const chainWu = {
    id: 'wu-1', title: 't', status: 'done', assigneeId: null,
    metadata: null, type: 'task', createdAt: '2026-09-01T00:00:00.000Z',
    claimedAt: null, completedAt: null,
  };

  it('chain workunit：§10 字段（type/createdAt/claimedAt/completedAt）+ metadata 必填可空', () => {
    expect(requirementChainWorkUnitSchema.parse(chainWu)).toEqual(chainWu);
    expect(requirementChainWorkUnitSchema.parse({ ...chainWu, assigneeRoleId: 'r-1' }).assigneeRoleId).toBe('r-1');
    const { metadata: _m, ...noMeta } = chainWu;
    expect(requirementChainWorkUnitSchema.safeParse(noMeta).success).toBe(false);
  });

  it('chain stat entry：finished/total 必填', () => {
    const entry = { finished: 1, total: 2 };
    expect(chainStatEntrySchema.parse(entry)).toEqual(entry);
    expect(chainStatEntrySchema.safeParse({ finished: 1 }).success).toBe(false);
  });

  it('响应壳：{ data } 统一；chain-stats 不存在的需求 key 缺省（record 语义）', () => {
    expect(requirementListResponseSchema.parse({ data: [reqRow] }).data).toHaveLength(1);
    expect(requirementResponseSchema.parse({ data: reqRow }).data.id).toBe('REQ-0001');
    expect(requirementChainResponseSchema.parse({
      data: { requirement: reqRow, workunits: [chainWu] },
    }).data.workunits).toHaveLength(1);
    expect(requirementChainSchema.safeParse({ requirement: reqRow }).success).toBe(false);
    expect(chainStatsResultSchema.parse({ 'REQ-0001': { finished: 1, total: 2 } }))
      .toEqual({ 'REQ-0001': { finished: 1, total: 2 } });
    expect(chainStatsResponseSchema.parse({ data: {} }).data).toEqual({});
  });

  it('index.ts 出口包含 requirements 域 schema', () => {
    expect(contractIndex.requirementSchema).toBe(requirementSchema);
    expect(contractIndex.createRequirementBodySchema).toBe(createRequirementBodySchema);
    expect(contractIndex.chainStatsQuerySchema).toBe(chainStatsQuerySchema);
  });
});
