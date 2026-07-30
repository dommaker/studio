/**
 * PMO-b（决策 1）：交付守卫与台账测试
 *
 * 覆盖：getDeliveryStatus 汇总（WU 完结/三层证据缺口/自评计数/deliverable）
 *       deliverProject 全分支（branch-only / not-ready / no-repo / checkout-mismatch
 *       / conflict / 成功合并 + 交付落档）与 human-only 由 routes 层兜底（不在此测）。
 * git 调用（execSh）与 getDefaultBranch 全部 mock。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkUnitSnapshot } from '@dommaker/studio-shared';
import { getDeliveryStatus, deliverProject } from '../delivery.js';
import type { ProjectData } from '../project.service.js';

const { mockExecSh, mockGetDefaultBranch } = vi.hoisted(() => ({
  mockExecSh: vi.fn(),
  mockGetDefaultBranch: vi.fn(),
}));

vi.mock('@dommaker/studio-shared/node', async (importOriginal) => {
  const orig = await importOriginal() as Record<string, unknown>;
  return { ...orig, execSh: mockExecSh };
});

vi.mock('@dommaker/studio-agent', () => ({
  getDefaultBranch: mockGetDefaultBranch,
}));

function project(overrides: Partial<ProjectData>): ProjectData {
  return {
    id: 'proj-1', pmoNumber: 'PMO-11', title: 't', description: null, requirement: null,
    companyId: null, okrId: null, status: 'active', priority: 'normal', progress: 50,
    gitBranch: 'PMO-11', gitRepo: '/repo/x', specFilePath: null, requirementsDocId: null,
    startedAt: null, completedAt: null, createdAt: '2026-07-29T00:00:00Z', updatedAt: '2026-07-29T00:00:00Z',
    ...overrides,
  };
}

let seq = 0;
function wu(overrides: Partial<WorkUnitSnapshot> & { metadataObj?: Record<string, unknown> }): WorkUnitSnapshot {
  const { metadataObj, ...rest } = overrides;
  return {
    id: `wu-${++seq}`, parentId: null, type: 'task', scope: 's', assigneeId: null,
    status: 'done', failureType: null, retryCount: 0, timeoutAt: null,
    channelId: null, projectPath: null, reqId: 'REQ-0011',
    metadata: metadataObj ? JSON.stringify(metadataObj) : null,
    createdAt: '2026-07-29T00:00:00Z', updatedAt: '2026-07-29T00:00:00Z',
    claimedAt: null, completedAt: '2026-07-29T01:00:00Z',
    ...rest,
  };
}

const att = (kind: string, extra: Record<string, unknown> = {}) => ({
  verdict: 'approved', by: 'x', at: '2026-07-29T00:30:00Z', kind, ...extra,
});

function makeDeps(input: {
  project?: ProjectData | null;
  reqs?: Array<{ id: string; projectId?: string | null }>;
  snapshots?: WorkUnitSnapshot[];
}) {
  return {
    getProject: async () => input.project === undefined ? project({}) : input.project,
    listRequirements: async () => input.reqs ?? [{ id: 'REQ-0011', projectId: 'proj-1' }],
    getIndex: async () => input.snapshots ?? [],
    updateProject: vi.fn(async (id: string, patch: Record<string, unknown>) => project({ id, ...patch } as ProjectData)),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  seq = 0;
  mockExecSh.mockResolvedValue({ stdout: '', stderr: '' });
  mockGetDefaultBranch.mockReturnValue('master');
});

describe('getDeliveryStatus（PMO-b 台账）', () => {
  it('项目不存在 → null', async () => {
    expect(await getDeliveryStatus('proj-x', undefined, makeDeps({ project: null }))).toBeNull();
  });

  it('证据齐 → deliverable；缺口分桶到 l1/l2/l3 并出人话清单', async () => {
    const ready = wu({ metadataObj: { attestations: { l1: att('verify'), l2: att('agent-review'), l3: att('human-confirm') } } });
    const deps = makeDeps({ snapshots: [ready] });
    const s = await getDeliveryStatus('proj-1', undefined, deps);
    expect(s!.deliverable).toBe(true);
    expect(s!.missing).toEqual([]);
    expect(s!.wu).toEqual({ total: 1, finished: 1, inFlight: 0 });

    const gaps = wu({ metadataObj: { attestations: { l2: att('agent-review', { selfReview: true }) } } });
    const doing = wu({ status: 'active', metadataObj: {} });
    const s2 = await getDeliveryStatus('proj-1', undefined, makeDeps({ snapshots: [gaps, doing] }));
    expect(s2!.deliverable).toBe(false);
    expect(s2!.wu).toEqual({ total: 2, finished: 1, inFlight: 1 });
    expect(s2!.evidence.l1Missing).toEqual([gaps.id]); // task 类型缺 l1
    expect(s2!.evidence.l3Missing).toEqual([gaps.id]);
    expect(s2!.evidence.l2Missing).toEqual([]);
    expect(s2!.evidence.selfReviewCount).toBe(1);
    expect(s2!.missing.join(' ')).toContain('1 个 WorkUnit 未完成');
    expect(s2!.missing.join(' ')).toContain('L1 自动验证');
    expect(s2!.missing.join(' ')).toContain('L3 人工确认');
  });

  it('非代码类 WU 不要求 l1；无关联 WU → 不可交付', async () => {
    const analysis = wu({ type: 'analysis', metadataObj: { attestations: { l2: att('agent-review'), l3: att('human-confirm') } } });
    const s = await getDeliveryStatus('proj-1', undefined, makeDeps({ snapshots: [analysis] }));
    expect(s!.deliverable).toBe(true);

    const s2 = await getDeliveryStatus('proj-1', undefined, makeDeps({ snapshots: [] }));
    expect(s2!.deliverable).toBe(false);
    expect(s2!.missing).toContain('无关联 WorkUnit');
  });

  it('legacy WU（无 attestations）= 证据缺口（台账诚实——没评审就是没评审）', async () => {
    const legacy = wu({ metadataObj: {} });
    const s = await getDeliveryStatus('proj-1', undefined, makeDeps({ snapshots: [legacy] }));
    expect(s!.evidence.l1Missing).toEqual([legacy.id]); // task 类型
    expect(s!.evidence.l2Missing).toEqual([legacy.id]);
    expect(s!.evidence.l3Missing).toEqual([legacy.id]);
    expect(s!.deliverable).toBe(false);
  });

  it('analysis 派生链：无关联 Requirement 时按 metadata.pmoId 回退归属', async () => {
    const ready = wu({ reqId: null, metadataObj: { pmoId: 'proj-1', attestations: { l1: att('verify'), l2: att('agent-review'), l3: att('human-confirm') } } });
    const other = wu({ reqId: null, metadataObj: { pmoId: 'proj-2', attestations: {} } });
    const s = await getDeliveryStatus('proj-1', undefined, makeDeps({ reqs: [], snapshots: [ready, other] }));
    expect(s!.wu).toEqual({ total: 1, finished: 1, inFlight: 0 }); // proj-2 的 WU 不计入
    expect(s!.missing).not.toContain('无关联 WorkUnit');
    expect(s!.deliverable).toBe(true);
  });

  it('pmoId 回退：证据缺口如实列出（缺 L1 不因回退豁免）；坏 metadata 容错', async () => {
    const gaps = wu({ reqId: null, metadataObj: { pmoId: 'proj-1', attestations: { l2: att('agent-review'), l3: att('human-confirm') } } });
    const broken = wu({ reqId: null, metadata: '{broken-json' });
    const s = await getDeliveryStatus('proj-1', undefined, makeDeps({ reqs: [], snapshots: [gaps, broken] }));
    expect(s!.wu.total).toBe(1);
    expect(s!.deliverable).toBe(false);
    expect(s!.evidence.l1Missing).toEqual([gaps.id]); // task 类型缺 l1
    expect(s!.missing.join(' ')).toContain('L1 自动验证');
    expect(s!.missing).not.toContain('无关联 WorkUnit');
  });
});

describe('deliverProject（PMO-b 交付守卫）', () => {
  const readyWu = () => wu({ metadataObj: { attestations: { l1: att('verify'), l2: att('agent-review'), l3: att('human-confirm') } } });

  it('branch-only → 拒绝并附分支名（不碰合并链路）', async () => {
    const deps = makeDeps({ project: project({ deliveryPolicy: 'branch-only' }), snapshots: [readyWu()] });
    const r = await deliverProject('proj-1', 'Alice', undefined, deps);
    expect(r.delivered).toBe(false);
    expect(r.reason).toBe('branch-only');
    expect(mockExecSh).not.toHaveBeenCalled();
  });

  it('auto-merge 缺证据 → not-ready 硬拒（附缺口）', async () => {
    const deps = makeDeps({ project: project({ deliveryPolicy: 'auto-merge' }), snapshots: [wu({ metadataObj: {} })] });
    const r = await deliverProject('proj-1', 'Alice', undefined, deps);
    expect(r).toMatchObject({ delivered: false, reason: 'not-ready' });
    expect(mockExecSh).not.toHaveBeenCalled();
  });

  it('auto-merge 证据齐 → 合并到默认分支并落档交付记录', async () => {
    mockExecSh.mockImplementation(async (cmd: string) => {
      if (cmd.includes('abbrev-ref')) return { stdout: 'master\n', stderr: '' };
      if (cmd.includes('rev-parse HEAD')) return { stdout: 'feedbeef\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const deps = makeDeps({ project: project({ deliveryPolicy: 'auto-merge' }), snapshots: [readyWu()] });
    const r = await deliverProject('proj-1', 'Alice', undefined, deps);

    expect(r).toMatchObject({ delivered: true, deliverCommit: 'feedbeef' });
    const cmds = mockExecSh.mock.calls.map(c => c[0] as string);
    expect(cmds.some(c => c.includes('merge --no-ff') && c.includes('PMO-11') && c.includes('deliver: PMO-11'))).toBe(true);
    expect(deps.updateProject).toHaveBeenCalledWith('proj-1', expect.objectContaining({
      deliveredBy: 'Alice',
      deliverCommit: 'feedbeef',
    }));
  });

  it('主仓 checkout 不是默认分支 → 拒绝打扰', async () => {
    mockExecSh.mockImplementation(async (cmd: string) =>
      cmd.includes('abbrev-ref') ? { stdout: 'feature/wip\n', stderr: '' } : { stdout: '', stderr: '' });
    const deps = makeDeps({ project: project({ deliveryPolicy: 'auto-merge' }), snapshots: [readyWu()] });
    const r = await deliverProject('proj-1', 'Alice', undefined, deps);
    expect(r).toMatchObject({ delivered: false, reason: 'checkout-mismatch' });
  });

  it('合并冲突 → conflict + 冲突文件清单（不自动 rebase，人工解决）', async () => {
    mockExecSh.mockImplementation(async (cmd: string) => {
      if (cmd.includes('abbrev-ref')) return { stdout: 'master\n', stderr: '' };
      if (cmd.includes('merge --no-ff')) throw new Error('CONFLICT (content): Merge conflict in a.ts');
      if (cmd.includes('diff-filter=U')) return { stdout: 'a.ts\nb.ts\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const deps = makeDeps({ project: project({ deliveryPolicy: 'auto-merge' }), snapshots: [readyWu()] });
    const r = await deliverProject('proj-1', 'Alice', undefined, deps);
    expect(r).toMatchObject({ delivered: false, reason: 'conflict', conflictFiles: ['a.ts', 'b.ts'] });
  });
});
