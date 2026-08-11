/**
 * PMO-b（决策 3）：WU → PMO 分支解析测试
 *
 * 2026-08 归因统一（canonical key = pmoId，两个逻辑级）：
 *   ① 创建期直读戳 metadata.pmoId ‖ legacy ownershipProjectId（同级，pmoId 优先）
 *   ② reqId → REQ（别名视图）→ projectId → PMO
 * metadata.pmoProjectId 已移出解析链（冗余缓存，生产存量为零）。
 *
 * 覆盖：pmoId 直读命中（analysis 派生链回归：仅 pmoId、reqId=null 的 task WU）/
 *       legacy ownershipProjectId 同级命中 / 直读戳优先于 reqId 派生 / reqId 派生 /
 *       pmoProjectId 不再命中 / gitBranch 缺省回落 pmoNumber / 全失败 null / 逐级容错。
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
  it('metadata.pmoId 直读命中（analysis 派生链回归：reqId=null 的 task WU）→ 分支 + deliveryPolicy', async () => {
    const r = await resolvePmoBranchForWU(
      { reqId: null, metadata: JSON.stringify({ pmoId: 'proj-1', pmoNumber: 'PMO-11' }) },
      undefined,
      { getProject: async () => project({}) },
    );
    expect(r).toEqual({ projectId: 'proj-1', branch: 'PMO-11', deliveryPolicy: 'branch-only' });
  });

  it('legacy metadata.ownershipProjectId 同级命中（读兼容）', async () => {
    const r = await resolvePmoBranchForWU(
      { metadata: JSON.stringify({ ownershipProjectId: 'proj-1' }) },
      undefined,
      { getProject: async () => project({}) },
    );
    expect(r).toEqual({ projectId: 'proj-1', branch: 'PMO-11', deliveryPolicy: 'branch-only' });
  });

  it('同级内 pmoId 优先于 legacy ownershipProjectId', async () => {
    const r = await resolvePmoBranchForWU(
      { metadata: JSON.stringify({ pmoId: 'proj-a', ownershipProjectId: 'proj-b' }) },
      undefined,
      { getProject: async (id: string) => project({ id, gitBranch: `br-${id}` }) },
    );
    expect(r?.branch).toBe('br-proj-a');
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

  it('直读戳优先于 reqId 派生（两者不一致时）', async () => {
    const r = await resolvePmoBranchForWU(
      { reqId: 'REQ-0011', metadata: JSON.stringify({ pmoId: 'proj-a' }) },
      undefined,
      {
        getProject: async (id: string) => project({ id, gitBranch: `br-${id}` }),
        getRequirement: async () => ({ projectId: 'proj-b' }),
      },
    );
    expect(r?.branch).toBe('br-proj-a');
  });

  it('metadata.pmoProjectId 不再参与解析（无直读戳且无 reqId → null）', async () => {
    const r = await resolvePmoBranchForWU(
      { metadata: JSON.stringify({ pmoProjectId: 'proj-1' }) },
      undefined,
      { getProject: async () => project({}) },
    );
    expect(r).toBeNull();
  });

  it('gitBranch 缺省 → 回落 pmoNumber（分支名 = PMO id）', async () => {
    const r = await resolvePmoBranchForWU(
      { metadata: JSON.stringify({ pmoId: 'proj-1' }) },
      undefined,
      { getProject: async () => project({ gitBranch: null }) },
    );
    expect(r?.branch).toBe('PMO-11');
  });

  it('deliveryPolicy 透出（auto-merge）', async () => {
    const r = await resolvePmoBranchForWU(
      { metadata: JSON.stringify({ pmoId: 'proj-1' }) },
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
      { metadata: JSON.stringify({ pmoId: 'proj-1' }) },
      undefined,
      { getProject: async () => { throw new Error('fs exploded'); } },
    );
    expect(r).toBeNull();
  });
});

describe('resolvePmoBranchForWU 多腿（#113 T7：按腿解析 WU 归属分支）', () => {
  const multiLegProject = () => project({
    deliveries: [
      { gitRepo: '/repo/a', branch: 'PMO-11-a', status: 'pending' },
      { gitRepo: '/repo/b', branch: 'PMO-11-b', status: 'pending' },
    ],
  });

  it('WU metadata.workspaceRoot 命中腿 gitRepo → 腿分支', async () => {
    const r = await resolvePmoBranchForWU(
      { metadata: JSON.stringify({ pmoId: 'proj-1', workspaceRoot: '/repo/b' }) },
      undefined,
      { getProject: async () => multiLegProject() },
    );
    expect(r).toEqual({ projectId: 'proj-1', branch: 'PMO-11-b', deliveryPolicy: 'branch-only' });
  });

  it('WU metadata.pmoBranch 命中腿 branch → 腿分支；worktreeBaseRepo 同口径', async () => {
    const byBranch = await resolvePmoBranchForWU(
      { metadata: JSON.stringify({ pmoId: 'proj-1', pmoBranch: 'PMO-11-a' }) },
      undefined,
      { getProject: async () => multiLegProject() },
    );
    expect(byBranch?.branch).toBe('PMO-11-a');

    const byBaseRepo = await resolvePmoBranchForWU(
      { metadata: JSON.stringify({ pmoId: 'proj-1', worktreeBaseRepo: '/repo/b' }) },
      undefined,
      { getProject: async () => multiLegProject() },
    );
    expect(byBaseRepo?.branch).toBe('PMO-11-b');
  });

  it('多腿项目未命中任何腿 → 回落项目级 gitBranch || pmoNumber（现状口径）', async () => {
    const r = await resolvePmoBranchForWU(
      { metadata: JSON.stringify({ pmoId: 'proj-1' }) },
      undefined,
      { getProject: async () => multiLegProject() },
    );
    expect(r?.branch).toBe('PMO-11');
  });

  it('单腿项目（无 deliveries）不受腿归属影响（回归）', async () => {
    const r = await resolvePmoBranchForWU(
      { metadata: JSON.stringify({ pmoId: 'proj-1', workspaceRoot: '/elsewhere' }) },
      undefined,
      { getProject: async () => project({}) },
    );
    expect(r?.branch).toBe('PMO-11');
  });
});

describe('resolvePmoProjectIdForWU（2026-07 PMO-flow UX §6：只出项目 id）', () => {
  it('① metadata.pmoId 直读命中且项目存在（analysis 派生链回归：reqId=null）→ 项目 id', async () => {
    const r = await resolvePmoProjectIdForWU(
      { reqId: null, metadata: JSON.stringify({ pmoId: 'proj-1' }) },
      undefined,
      { getProject: async id => (id === 'proj-1' ? project({}) : null) },
    );
    expect(r).toBe('proj-1');
  });

  it('① legacy metadata.ownershipProjectId 同级命中（读兼容）', async () => {
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

  it('链序优先：① 直读戳优先于 ② reqId 派生（两者不一致时）', async () => {
    const r = await resolvePmoProjectIdForWU(
      { reqId: 'REQ-0011', metadata: JSON.stringify({ pmoId: 'proj-a' }) },
      undefined,
      {
        getProject: async id => project({ id }),
        getRequirement: async () => ({ projectId: 'proj-b' }),
      },
    );
    expect(r).toBe('proj-a');
  });

  it('metadata.pmoProjectId 已移出解析链：仅 pmoProjectId 的 WU → null', async () => {
    const r = await resolvePmoProjectIdForWU(
      { reqId: 'REQ-0011', metadata: JSON.stringify({ pmoProjectId: 'proj-3' }) },
      undefined,
      {
        getProject: async id => project({ id }),
        getRequirement: async () => null,
      },
    );
    expect(r).toBeNull();
  });

  it('单级项目不存在 → 落下一级；全失败 → null', async () => {
    // ① 指向不存在项目 → 落 ②
    const r = await resolvePmoProjectIdForWU(
      { reqId: 'REQ-0011', metadata: JSON.stringify({ pmoId: 'ghost' }) },
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
        { reqId: 'REQ-0001', metadata: JSON.stringify({ pmoId: 'ghost' }) },
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
    // ① 项目不存在（getProject 只对 proj-2 命中）→ ② 抛错容错 → null
    const r = await resolvePmoProjectIdForWU(
      { reqId: 'REQ-0011', metadata: JSON.stringify({ pmoId: 'ghost' }) },
      undefined,
      {
        getProject: async id => (id === 'proj-2' ? project({ id: 'proj-2' }) : null),
        getRequirement: async () => { throw new Error('fs exploded'); },
      },
    );
    expect(r).toBeNull();

    expect(
      await resolvePmoProjectIdForWU(
        { metadata: JSON.stringify({ pmoId: 'proj-1' }) },
        undefined,
        { getProject: async () => { throw new Error('fs exploded'); } },
      ),
    ).toBeNull();
  });
});
