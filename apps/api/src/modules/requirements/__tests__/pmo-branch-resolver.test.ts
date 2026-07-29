/**
 * PMO-b（决策 3）：WU → PMO 分支解析测试
 *
 * 覆盖：ownershipProjectId 直查命中 / reqId → REQ（别名视图）→ PMO /
 *       gitBranch 缺省回落 pmoNumber / 无关联返回 null / 逐级容错。
 */
import { describe, it, expect } from 'vitest';
import { resolvePmoBranchForWU } from '../pmo-branch-resolver.js';
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
