/**
 * PMO-b（决策 3）：WU → PMO 分支解析测试
 *
 * 覆盖：ownershipProjectId 直查命中 / reqId → REQ（别名视图）→ PMO /
 *       gitBranch 缺省回落 pmoNumber / 无关联返回 null / 逐级容错。
 */
import { describe, it, expect } from 'vitest';
import { resolvePmoBranchForWU, resolvePmoProjectIdForWU } from '../pmo-branch-resolver.js';
import type { ProjectData } from '../../pmo/project.service.js';

function project(overrides: Partial<ProjectData>): ProjectData {
  return {
    id: 'proj-1', pmoNumber: 'PMO-11', title: 't', description: null, requirement: null,
    companyId: null, okrId: null, status: 'active', priority: 'normal', progress: 0,
    gitBranch: 'PMO-11', gitRepo: '/repo/x', specFilePath: null, requirementsDocId: null,
    startedAt: null, completedAt: null, createdAt: '2026-07-29T00:00:00Z', updatedAt: '2026-07-29T00:00:00Z',
    ...overrides,
  };
}

describe('resolvePmoBranchForWU（PMO-b 决策 3）', () => {
  it('metadata.ownershipProjectId 命中 → 直接解析', async () => {
    const r = await resolvePmoBranchForWU(
      { metadata: JSON.stringify({ ownershipProjectId: 'proj-1' }) },
      undefined,
      { getProject: async () => project({}) },
    );
    expect(r).toEqual({ projectId: 'proj-1', branch: 'PMO-11', deliveryPolicy: 'branch-only' });
  });

  it('reqId → REQ projectId → PMO（决策 4 别名视图同链）', async () => {
    const r = await resolvePmoBranchForWU(
      { reqId: 'REQ-0011' },
      undefined,
      {
        getProject: async (id: string) => (id === 'proj-1' ? project({}) : null),
        getRequirement: async () => ({ projectId: 'proj-1' }),
      },
    );
    expect(r?.branch).toBe('PMO-11');
  });

  it('ownershipProjectId 优先于 reqId', async () => {
    const r = await resolvePmoBranchForWU(
      { reqId: 'REQ-0011', metadata: JSON.stringify({ ownershipProjectId: 'proj-a' }) },
      undefined,
      {
        getProject: async (id: string) => project({ id, gitBranch: `br-${id}` }),
        getRequirement: async () => ({ projectId: 'proj-b' }),
      },
    );
    expect(r?.branch).toBe('br-proj-a');
  });

  it('gitBranch 缺省 → 回落 pmoNumber（分支名 = PMO id）', async () => {
    const r = await resolvePmoBranchForWU(
      { metadata: JSON.stringify({ ownershipProjectId: 'proj-1' }) },
      undefined,
      { getProject: async () => project({ gitBranch: null }) },
    );
    expect(r?.branch).toBe('PMO-11');
  });

  it('deliveryPolicy 透出（auto-merge）', async () => {
    const r = await resolvePmoBranchForWU(
      { metadata: JSON.stringify({ ownershipProjectId: 'proj-1' }) },
      undefined,
      { getProject: async () => project({ deliveryPolicy: 'auto-merge' }) },
    );
    expect(r?.deliveryPolicy).toBe('auto-merge');
  });

  it('无关联 / 项目不存在 / metadata 损坏 → null（调用方回落现状）', async () => {
    expect(await resolvePmoBranchForWU({}, undefined, { getProject: async () => null })).toBeNull();
    expect(
      await resolvePmoBranchForWU(
        { metadata: '{broken' },
        undefined,
        { getProject: async () => null },
      ),
    ).toBeNull();
    expect(
      await resolvePmoBranchForWU(
        { reqId: 'REQ-0001' },
        undefined,
        { getProject: async () => null, getRequirement: async () => null },
      ),
    ).toBeNull();
  });

  it('依赖抛错 → 容错返回 null，不放大基础设施故障', async () => {
    const r = await resolvePmoBranchForWU(
      { metadata: JSON.stringify({ ownershipProjectId: 'proj-1' }) },
      undefined,
      { getProject: async () => { throw new Error('fs exploded'); } },
    );
    expect(r).toBeNull();
  });
});

describe('resolvePmoProjectIdForWU（2026-07 PMO-flow UX §6：只出项目 id）', () => {
  it('① metadata.ownershipProjectId 命中且项目存在 → 项目 id', async () => {
    const r = await resolvePmoProjectIdForWU(
      { metadata: JSON.stringify({ ownershipProjectId: 'proj-1' }) },
      undefined,
      { getProject: async id => (id === 'proj-1' ? project({}) : null) },
    );
    expect(r).toBe('proj-1');
  });

  it('② reqId → Requirement.projectId 命中（① 缺失时）', async () => {
    const r = await resolvePmoProjectIdForWU(
      { reqId: 'REQ-0011' },
      undefined,
      {
        getProject: async id => (id === 'proj-1' ? project({}) : null),
        getRequirement: async () => ({ projectId: 'proj-1' }),
      },
    );
    expect(r).toBe('proj-1');
  });

  it('③ metadata.pmoProjectId 命中（①② 均落空时）', async () => {
    const r = await resolvePmoProjectIdForWU(
      { reqId: 'REQ-0011', metadata: JSON.stringify({ pmoProjectId: 'proj-3' }) },
      undefined,
      {
        getProject: async id => (id === 'proj-3' ? project({ id: 'proj-3' }) : null),
        getRequirement: async () => null,
      },
    );
    expect(r).toBe('proj-3');
  });

  it('链序优先：① 优先于 ②，② 优先于 ③', async () => {
    const r = await resolvePmoProjectIdForWU(
      {
        reqId: 'REQ-0011',
        metadata: JSON.stringify({ ownershipProjectId: 'proj-a', pmoProjectId: 'proj-c' }),
      },
      undefined,
      {
        getProject: async id => project({ id }),
        getRequirement: async () => ({ projectId: 'proj-b' }),
      },
    );
    expect(r).toBe('proj-a');

    const r2 = await resolvePmoProjectIdForWU(
      { reqId: 'REQ-0011', metadata: JSON.stringify({ pmoProjectId: 'proj-c' }) },
      undefined,
      {
        getProject: async id => project({ id }),
        getRequirement: async () => ({ projectId: 'proj-b' }),
      },
    );
    expect(r2).toBe('proj-b');
  });

  it('单级项目不存在 → 落下一级；全失败 → null', async () => {
    // ① 指向不存在项目 → 落 ②
    const r = await resolvePmoProjectIdForWU(
      { reqId: 'REQ-0011', metadata: JSON.stringify({ ownershipProjectId: 'ghost' }) },
      undefined,
      {
        getProject: async id => (id === 'proj-1' ? project({}) : null),
        getRequirement: async () => ({ projectId: 'proj-1' }),
      },
    );
    expect(r).toBe('proj-1');

    // 全落空
    expect(
      await resolvePmoProjectIdForWU(
        { reqId: 'REQ-0001', metadata: JSON.stringify({ pmoProjectId: 'ghost' }) },
        undefined,
        { getProject: async () => null, getRequirement: async () => ({ projectId: 'ghost' }) },
      ),
    ).toBeNull();
    expect(await resolvePmoProjectIdForWU({}, undefined, { getProject: async () => null })).toBeNull();
    expect(
      await resolvePmoProjectIdForWU({ metadata: '{broken' }, undefined, { getProject: async () => null }),
    ).toBeNull();
  });

  it('依赖抛错 → 容错继续下一级 / 返回 null', async () => {
    const r = await resolvePmoProjectIdForWU(
      { reqId: 'REQ-0011', metadata: JSON.stringify({ ownershipProjectId: 'proj-1', pmoProjectId: 'proj-3' }) },
      undefined,
      {
        getProject: async id => (id === 'proj-3' ? project({ id: 'proj-3' }) : null),
        getRequirement: async () => { throw new Error('fs exploded'); },
      },
    );
    // ① 项目不存在（getProject 只对 proj-3 命中）→ ② 抛错容错 → ③ 命中
    expect(r).toBe('proj-3');

    expect(
      await resolvePmoProjectIdForWU(
        { metadata: JSON.stringify({ ownershipProjectId: 'proj-1' }) },
        undefined,
        { getProject: async () => { throw new Error('fs exploded'); } },
      ),
    ).toBeNull();
  });
});
