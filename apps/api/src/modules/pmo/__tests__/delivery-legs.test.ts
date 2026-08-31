/**
 * #113 T7（#106 子票）：交付守卫按腿循环——多腿台账与逐腿 auto-merge 测试
 *
 * 覆盖：
 * - 逐腿台账：证据齐缺（l1/l2/l3）/deliverable/gaps/missing 按腿独立汇总；
 *   WU→腿归属 = metadata.workspaceRoot/worktreeBaseRepo 命中腿 gitRepo 或 pmoBranch 命中腿 branch；
 *   未分腿公共 WU 保守计入每条腿
 * - 整体 deliverable = 全部腿 deliverable（零 WU 腿不阻断，全项目无 WU 仍不可交付）
 * - auto-merge 逐腿执行：逐腿合并/逐腿落档 delivered；一腿冲突不阻断他腿；
 *   任一腿未交付 → 整体 delivered=false；全腿交付才写项目级 deliveredAt
 *
 * 单腿回归由 delivery.test.ts 兜底（不改断言全绿）。
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

const TWO_LEGS = [
  { gitRepo: '/repo/a', branch: 'PMO-11-a', status: 'pending' },
  { gitRepo: '/repo/b', branch: 'PMO-11-b', status: 'pending' },
];

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
const fullEvidence = { attestations: { l1: att('verify'), l2: att('agent-review'), l3: att('human-confirm') } };

function makeDeps(input: {
  project?: ProjectData | null;
  reqs?: Array<{ id: string; projectId?: string | null }>;
  snapshots?: WorkUnitSnapshot[];
}) {
  return {
    getProject: async () => input.project === undefined ? project({ deliveries: TWO_LEGS }) : input.project,
    listRequirements: async () => input.reqs ?? [{ id: 'REQ-0011', projectId: 'proj-1' }],
    getIndex: async () => input.snapshots ?? [],
    updateProject: vi.fn(async (id: string, patch: Record<string, unknown>) => project({ id, ...patch } as ProjectData)),
    sumTokens: async () => 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  seq = 0;
  mockExecSh.mockResolvedValue({ stdout: '', stderr: '' });
  mockGetDefaultBranch.mockReturnValue('master');
});

describe('getDeliveryStatus 多腿台账（#113 T7）', () => {
  it('逐腿证据独立汇总：腿 A 齐 / 腿 B 缺 l1+l3，各自 deliverable 独立', async () => {
    const aReady = wu({ metadataObj: { workspaceRoot: '/repo/a', ...fullEvidence } });
    const bGaps = wu({ metadataObj: { workspaceRoot: '/repo/b', attestations: { l2: att('agent-review') } } });
    const s = await getDeliveryStatus('proj-1', undefined, makeDeps({ snapshots: [aReady, bGaps] }));

    expect(s!.legs).toHaveLength(2);
    const [legA, legB] = s!.legs!;
    expect(legA.branch).toBe('PMO-11-a');
    expect(legA.wu).toEqual({ total: 1, finished: 1, inFlight: 0, byStatus: { unassigned: 0, active: 0, inReview: 0, blocked: 0 } });
    expect(legA.deliverable).toBe(true);
    expect(legA.missing).toEqual([]);
    expect(legA.gaps).toEqual([]);

    expect(legB.branch).toBe('PMO-11-b');
    expect(legB.deliverable).toBe(false);
    expect(legB.evidence.l1Missing).toEqual([bGaps.id]);
    expect(legB.evidence.l3Missing).toEqual([bGaps.id]);
    expect(legB.evidence.l2Missing).toEqual([]);
    expect(legB.gaps).toEqual([{ id: bGaps.id, title: 's', type: 'task', missing: ['l1', 'l3'] }]);

    // 整体 = 全腿 deliverable 才翻转
    expect(s!.deliverable).toBe(false);
    // 整体 missing 带腿前缀（人话清单定位到腿）
    expect(s!.missing.some(m => m.startsWith('[PMO-11-b]') && m.includes('缺自动验证'))).toBe(true);
    expect(s!.missing.some(m => m.startsWith('[PMO-11-a]'))).toBe(false);
  });

  it('归属口径：worktreeBaseRepo / pmoBranch 同样命中腿；未分腿公共 WU 保守计入每条腿', async () => {
    const byBaseRepo = wu({ metadataObj: { worktreeBaseRepo: '/repo/a', ...fullEvidence } });
    const byBranch = wu({ metadataObj: { pmoBranch: 'PMO-11-b', ...fullEvidence } });
    const shared = wu({ metadataObj: { ...fullEvidence } }); // 无任何腿戳
    const s = await getDeliveryStatus('proj-1', undefined, makeDeps({ snapshots: [byBaseRepo, byBranch, shared] }));

    const [legA, legB] = s!.legs!;
    expect(legA.wu.total).toBe(2); // byBaseRepo + shared
    expect(legB.wu.total).toBe(2); // byBranch + shared
    expect(legA.deliverable).toBe(true);
    expect(legB.deliverable).toBe(true);
    expect(s!.deliverable).toBe(true);
  });

  it('零 WU 腿不阻断整体 deliverable；全项目无 WU 仍不可交付', async () => {
    const aReady = wu({ metadataObj: { workspaceRoot: '/repo/a', ...fullEvidence } });
    const deps = makeDeps({
      project: project({ deliveries: [
        { gitRepo: '/repo/a', branch: 'PMO-11-a', status: 'pending' },
        { gitRepo: '/repo/b', branch: 'PMO-11-b', status: 'pending' },
      ] }),
      snapshots: [aReady],
    });
    const s = await getDeliveryStatus('proj-1', undefined, deps);
    expect(s!.legs![1].wu.total).toBe(0);
    expect(s!.deliverable).toBe(true);

    const s2 = await getDeliveryStatus('proj-1', undefined, makeDeps({ snapshots: [] }));
    expect(s2!.deliverable).toBe(false);
    expect(s2!.missing).toContain('无关联任务');
  });

  it('单腿（无 deliveries / 合成单腿）不输出 legs 字段（回归硬要求）', async () => {
    const ready = wu({ metadataObj: { ...fullEvidence } });
    const s = await getDeliveryStatus('proj-1', undefined, makeDeps({ project: project({}), snapshots: [ready] }));
    expect(s!.deliverable).toBe(true);
    expect(s!.legs).toBeUndefined();
  });
});

describe('deliverProject 多腿 auto-merge（#113 T7）', () => {
  const readyA = () => wu({ metadataObj: { workspaceRoot: '/repo/a', ...fullEvidence } });
  const readyB = () => wu({ metadataObj: { workspaceRoot: '/repo/b', ...fullEvidence } });
  const autoProject = () => project({ deliveryPolicy: 'auto-merge', deliveries: TWO_LEGS });

  it('全腿证据齐 → 逐腿合并 + 逐腿落档 delivered，全腿交付才写项目级交付记录', async () => {
    mockExecSh.mockImplementation(async (cmd: string) => {
      if (cmd.includes('abbrev-ref')) return { stdout: 'master\n', stderr: '' };
      if (cmd.includes('rev-parse HEAD')) return { stdout: cmd.includes('/repo/a') ? 'aaaa\n' : 'bbbb\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const deps = makeDeps({ project: autoProject(), snapshots: [readyA(), readyB()] });
    const r = await deliverProject('proj-1', 'Alice', undefined, deps);

    expect(r.delivered).toBe(true);
    expect(r.legs).toEqual([
      expect.objectContaining({ branch: 'PMO-11-a', delivered: true, deliverCommit: 'aaaa' }),
      expect.objectContaining({ branch: 'PMO-11-b', delivered: true, deliverCommit: 'bbbb' }),
    ]);
    const cmds = mockExecSh.mock.calls.map(c => c[0] as string);
    expect(cmds.some(c => c.includes(`/repo/a`) && c.includes('merge --no-ff') && c.includes('PMO-11-a'))).toBe(true);
    expect(cmds.some(c => c.includes(`/repo/b`) && c.includes('merge --no-ff') && c.includes('PMO-11-b'))).toBe(true);

    // 逐腿落档：deliveries 状态翻 delivered + 项目级交付记录一次性写入
    expect(deps.updateProject).toHaveBeenCalledWith('proj-1', expect.objectContaining({
      deliveredBy: 'Alice',
      deliveries: [
        expect.objectContaining({ branch: 'PMO-11-a', status: 'delivered', deliverCommit: 'aaaa' }),
        expect.objectContaining({ branch: 'PMO-11-b', status: 'delivered', deliverCommit: 'bbbb' }),
      ],
    }));
  });

  it('一腿冲突不阻断他腿：腿 A 合并成功落档，腿 B conflict，整体 delivered=false', async () => {
    mockExecSh.mockImplementation(async (cmd: string) => {
      if (cmd.includes('abbrev-ref')) return { stdout: 'master\n', stderr: '' };
      if (cmd.includes('/repo/b') && cmd.includes('merge --no-ff')) throw new Error('CONFLICT in b.ts');
      if (cmd.includes('/repo/b') && cmd.includes('diff-filter=U')) return { stdout: 'b.ts\n', stderr: '' };
      if (cmd.includes('rev-parse HEAD')) return { stdout: 'aaaa\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const deps = makeDeps({ project: autoProject(), snapshots: [readyA(), readyB()] });
    const r = await deliverProject('proj-1', 'Alice', undefined, deps);

    expect(r.delivered).toBe(false);
    expect(r.reason).toBe('conflict');
    expect(r.legs).toEqual([
      expect.objectContaining({ branch: 'PMO-11-a', delivered: true, deliverCommit: 'aaaa' }),
      expect.objectContaining({ branch: 'PMO-11-b', delivered: false, reason: 'conflict', conflictFiles: ['b.ts'] }),
    ]);
    // 成功的腿独立落档 delivered，失败的腿保持原状态；项目级 deliveredAt 不写
    const patch = deps.updateProject.mock.calls[0][1] as Record<string, unknown>;
    expect(patch.deliveries).toEqual([
      expect.objectContaining({ branch: 'PMO-11-a', status: 'delivered' }),
      expect.objectContaining({ branch: 'PMO-11-b', status: 'pending' }),
    ]);
    expect(patch.deliveredAt).toBeUndefined();
  });

  it('任一腿缺证据 → not-ready 硬拒，不做任何 git 调用', async () => {
    const bGaps = wu({ metadataObj: { workspaceRoot: '/repo/b' } });
    const deps = makeDeps({ project: autoProject(), snapshots: [readyA(), bGaps] });
    const r = await deliverProject('proj-1', 'Alice', undefined, deps);

    expect(r).toMatchObject({ delivered: false, reason: 'not-ready' });
    expect(r.missing!.some(m => m.startsWith('[PMO-11-b]'))).toBe(true);
    expect(mockExecSh).not.toHaveBeenCalled();
    expect(deps.updateProject).not.toHaveBeenCalled();
  });

  it('已 delivered 腿幂等跳过（不重复合并），其余腿正常交付', async () => {
    mockExecSh.mockImplementation(async (cmd: string) => {
      if (cmd.includes('abbrev-ref')) return { stdout: 'master\n', stderr: '' };
      if (cmd.includes('rev-parse HEAD')) return { stdout: 'bbbb\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const deps = makeDeps({
      project: project({ deliveryPolicy: 'auto-merge', deliveries: [
        { gitRepo: '/repo/a', branch: 'PMO-11-a', status: 'delivered', deliverCommit: 'aaaa' },
        { gitRepo: '/repo/b', branch: 'PMO-11-b', status: 'pending' },
      ] }),
      snapshots: [readyA(), readyB()],
    });
    const r = await deliverProject('proj-1', 'Alice', undefined, deps);

    expect(r.delivered).toBe(true);
    expect(r.legs![0]).toEqual(expect.objectContaining({ branch: 'PMO-11-a', delivered: true, reason: 'already-delivered' }));
    const cmds = mockExecSh.mock.calls.map(c => c[0] as string);
    expect(cmds.some(c => c.includes('/repo/a') && c.includes('merge --no-ff'))).toBe(false); // 不重复合并
    expect(cmds.some(c => c.includes('/repo/b') && c.includes('merge --no-ff'))).toBe(true);
  });

  it('多腿 branch-only → 仍只标记不碰链路（行为同单腿）', async () => {
    const deps = makeDeps({ project: project({ deliveries: TWO_LEGS }), snapshots: [readyA(), readyB()] });
    const r = await deliverProject('proj-1', 'Alice', undefined, deps);
    expect(r).toMatchObject({ delivered: false, reason: 'branch-only' });
    expect(mockExecSh).not.toHaveBeenCalled();
  });
});
