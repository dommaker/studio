/**
 * PMO-b（决策 1）：交付守卫与台账测试
 *
 * 覆盖：getDeliveryStatus 汇总（WU 完结/三层证据缺口/自评计数/deliverable）
 *       deliverProject 全分支（branch-only / not-ready / no-repo / checkout-mismatch
 *       / conflict / 成功合并 + 交付落档）与 human-only 由 routes 层兜底（不在此测）。
 * git 调用（execFile，桥接既有 execSh 场景表）与 getDefaultBranch 全部 mock。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FileStore, type MandateRecord, type WorkUnitSnapshot } from '@dommaker/studio-shared';
import { getDeliveryStatus, deliverProject, markProjectDelivered } from '../delivery.js';
import type { ProjectData } from '../project.service.js';

const { mockExecSh, mockExecFile, mockGetDefaultBranch } = vi.hoisted(() => ({
  mockExecSh: vi.fn(),
  mockExecFile: vi.fn(),
  mockGetDefaultBranch: vi.fn(),
}));

vi.mock('child_process', async (importOriginal) => {
  const orig = await importOriginal() as Record<string, unknown>;
  return { ...orig, execFile: mockExecFile };
});

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

function mandate(workUnitId: string): MandateRecord {
  const actor = { id: 'operator-1', type: 'Operator' } as const;
  return {
    workUnitId, revision: 1, policyVersion: '1', requestedBy: actor, grantedBy: actor,
    grantedAt: '2026-07-29T00:00:00Z', source: { kind: 'api' }, reqId: 'REQ-0011', pmoId: 'proj-1',
    repositories: [{ repo: '/repo/x', leg: 'PMO-11' }],
    deliveryActions: ['merge', 'deliver', 'mark-delivered'],
    budget: { tokens: null, planSteps: null }, expansionPrincipals: [],
    history: [{ revision: 1, action: 'issued', actor, at: '2026-07-29T00:00:00Z' }],
  };
}

let seq = 0;
function wu(overrides: Partial<WorkUnitSnapshot> & { metadataObj?: Record<string, unknown> }): WorkUnitSnapshot {
  const { metadataObj, ...rest } = overrides;
  const id = `wu-${++seq}`;
  return {
    id, parentId: null, type: 'task', scope: 's', assigneeId: null,
    status: 'done', failureType: null, retryCount: 0, timeoutAt: null,
    channelId: null, projectPath: null, reqId: 'REQ-0011',
    metadata: JSON.stringify({ worktreeBaseRepo: '/repo/x', pmoBranch: 'PMO-11', ...metadataObj }),
    mandate: mandate(id),
    createdAt: '2026-07-29T00:00:00Z', updatedAt: '2026-07-29T00:00:00Z',
    claimedAt: null, completedAt: '2026-07-29T01:00:00Z',
    ...rest,
  };
}

const att = (kind: string, extra: Record<string, unknown> = {}) => ({
  verdict: 'approved', by: 'x', at: '2026-07-29T00:30:00Z', kind, ...extra,
});
const mergeReceipt = {
  id: 'merge-1', merged: true, mergedAt: '2026-07-29T00:45:00Z',
  mergeCommit: 'c0ffee1234567890', targetBranch: 'PMO-11',
  verification: { status: 'passed', ran: ['pnpm test'] },
};
const fullEvidence = {
  mergeReceipt,
  attestations: { l1: att('verify'), l2: att('agent-review'), l3: att('human-confirm') },
};

function makeDeps(input: {
  project?: ProjectData | null;
  reqs?: Array<{ id: string; projectId?: string | null }>;
  snapshots?: WorkUnitSnapshot[];
  sumTokens?: (workUnitIds: Set<string>) => Promise<number>;
}) {
  return {
    getProject: async () => input.project === undefined ? project({}) : input.project,
    listRequirements: async () => input.reqs ?? [{ id: 'REQ-0011', projectId: 'proj-1' }],
    getIndex: async () => input.snapshots ?? [],
    updateProject: vi.fn(async (id: string, patch: Record<string, unknown>) => project({ id, ...patch } as ProjectData)),
    sumTokens: input.sumTokens ?? (async () => 0),
    withRepo: async <T>(repo: string, callback: (capabilityPath: string) => Promise<T>): Promise<T> => callback(repo),
    withLegLock: async <T>(_repo: string, _branch: string, callback: () => Promise<T>): Promise<T> => callback(),
    recordLearningOutcome: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  seq = 0;
  mockExecSh.mockResolvedValue({ stdout: '', stderr: '' });
  mockExecFile.mockImplementation((
    _cmd: string,
    args: string[],
    opts: { cwd: string; timeout: number },
    cb: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    mockExecSh(`git ${args.join(' ')}`, { cwd: opts.cwd, timeoutMs: opts.timeout }).then(
      (result: { stdout: string; stderr: string }) => cb(null, result.stdout, result.stderr),
      (error: Error) => cb(error, '', ''),
    );
  });
  mockGetDefaultBranch.mockReturnValue('master');
});

describe('getDeliveryStatus（PMO-b 台账）', () => {
  it('项目不存在 → null', async () => {
    expect(await getDeliveryStatus('proj-x', undefined, makeDeps({ project: null }))).toBeNull();
  });

  it('证据齐 → deliverable；缺口分桶到 l1/l2/l3 并出人话清单', async () => {
    const ready = wu({ metadataObj: fullEvidence });
    const deps = makeDeps({ snapshots: [ready] });
    const s = await getDeliveryStatus('proj-1', undefined, deps);
    expect(s!.deliverable).toBe(true);
    expect(s!.missing).toEqual([]);
    expect(s!.wu).toEqual({ total: 1, finished: 1, inFlight: 0, byStatus: { unassigned: 0, active: 0, inReview: 0, blocked: 0 } });
    expect(s!.tokens).toBe(0); // 缺省 sumTokens 注入为 0
    expect(s!.gaps).toEqual([]);

    const gaps = wu({ metadataObj: { attestations: { l2: att('agent-review', { selfReview: true }) } } });
    const doing = wu({ status: 'active', metadataObj: {} });
    const s2 = await getDeliveryStatus('proj-1', undefined, makeDeps({ snapshots: [gaps, doing] }));
    expect(s2!.deliverable).toBe(false);
    expect(s2!.wu).toEqual({ total: 2, finished: 1, inFlight: 1, byStatus: { unassigned: 0, active: 1, inReview: 0, blocked: 0 } });
    expect(s2!.evidence.l1Missing).toEqual([gaps.id]); // task 类型缺 l1
    expect(s2!.evidence.l3Missing).toEqual([gaps.id]);
    expect(s2!.evidence.l2Missing).toEqual([]);
    expect(s2!.evidence.selfReviewCount).toBe(1);
    // gaps 明细：只含已完成且有缺口的 WU，missing 顺序 l1→l2→l3→merge，标题回退 scope
    expect(s2!.evidence.mergeMissing).toEqual([gaps.id]);
    expect(s2!.gaps).toEqual([{ id: gaps.id, title: 's', type: 'task', missing: ['l1', 'l3', 'merge'] }]);
    expect(s2!.missing.join(' ')).toContain('1 个任务未完成');
    expect(s2!.missing.join(' ')).toContain('缺自动验证');
    expect(s2!.missing.join(' ')).toContain('缺人工确认');
    expect(s2!.missing.join(' ')).toContain('缺有效合并回执');
  });

  it('无目标验证命令且缺 L3 → verificationUnavailable + merge 缺口与人工确认文案', async () => {
    const item = wu({ metadataObj: {
      mergeReceipt: { ...mergeReceipt, verification: { status: 'unavailable', ran: [] } },
      attestations: { l1: att('verify'), l2: att('agent-review') },
    } });
    const s = await getDeliveryStatus('proj-1', undefined, makeDeps({ snapshots: [item] }));
    expect(s!.deliverable).toBe(false);
    expect(s!.evidence.mergeMissing).toEqual([]);
    expect(s!.evidence.verificationUnavailable).toEqual([item.id]);
    expect(s!.gaps).toEqual([{ id: item.id, title: 's', type: 'task', missing: ['l3', 'merge'] }]);
    expect(s!.missing.join(' ')).toContain('无目标验证命令');
    expect(s!.missing.join(' ')).toContain('需人工确认');
  });

  it('analysis/review 类 WU 豁免 L2（dispatcher 不派评审，验收闸是人工 L3）；缺 L3 仍不可交付', async () => {
    const analysis = wu({ type: 'analysis', metadataObj: { attestations: { l3: att('human-confirm') } } });
    const s = await getDeliveryStatus('proj-1', undefined, makeDeps({ snapshots: [analysis] }));
    expect(s!.evidence.l2Missing).toEqual([]); // 无 l2 不计缺口
    expect(s!.deliverable).toBe(true);

    const review = wu({ type: 'review', metadataObj: { attestations: { l3: att('human-confirm') } } });
    const s2 = await getDeliveryStatus('proj-1', undefined, makeDeps({ snapshots: [review] }));
    expect(s2!.evidence.l2Missing).toEqual([]);
    expect(s2!.deliverable).toBe(true);

    const noL3 = wu({ type: 'analysis', metadataObj: {} });
    const s3 = await getDeliveryStatus('proj-1', undefined, makeDeps({ snapshots: [noL3] }));
    expect(s3!.evidence.l2Missing).toEqual([]);
    expect(s3!.evidence.l3Missing).toEqual([noL3.id]);
    expect(s3!.deliverable).toBe(false);
    expect(s3!.gaps).toEqual([{ id: noL3.id, title: 's', type: 'analysis', missing: ['l3'] }]);
  });

  it('tokens/gaps 契约：token 按项目 WU id 集求和注入；gaps 标题取 metadata.title，坏 JSON 回退 scope', async () => {
    const titled = wu({ metadataObj: { title: '实现登录页', attestations: { l1: att('verify') } } });
    const broken = wu({ metadata: '{broken-json', scope: 'broken-scope' });
    const sumTokens = vi.fn(async () => 12345);
    const s = await getDeliveryStatus('proj-1', undefined, makeDeps({ snapshots: [titled, broken], sumTokens }));

    expect(s!.tokens).toBe(12345);
    expect(sumTokens).toHaveBeenCalledWith(new Set([titled.id, broken.id]));
    expect(s!.gaps).toEqual([
      { id: titled.id, title: '实现登录页', type: 'task', missing: ['l2', 'l3', 'merge'] },
      { id: broken.id, title: 'broken-scope', type: 'task', missing: ['l1', 'l2', 'l3', 'merge'] },
    ]);
  });

  it('token 聚合失败 → tokens=0（best-effort，不拖垮台账主流程）', async () => {
    const ready = wu({ metadataObj: fullEvidence });
    const s = await getDeliveryStatus('proj-1', undefined, makeDeps({
      snapshots: [ready],
      sumTokens: async () => { throw new Error('io error'); },
    }));
    expect(s!.tokens).toBe(0);
    expect(s!.deliverable).toBe(true);
  });

  it('非代码类 WU 不要求 l1；无关联 WU → 不可交付', async () => {
    const analysis = wu({ type: 'analysis', metadataObj: { attestations: { l2: att('agent-review'), l3: att('human-confirm') } } });
    const s = await getDeliveryStatus('proj-1', undefined, makeDeps({ snapshots: [analysis] }));
    expect(s!.deliverable).toBe(true);

    const s2 = await getDeliveryStatus('proj-1', undefined, makeDeps({ snapshots: [] }));
    expect(s2!.deliverable).toBe(false);
    expect(s2!.missing).toContain('无关联任务');
  });

  it('#376 归档口径：completed 零 WU → archived=true；cancelled/在途零 WU → archived=false；completed 有 WU → archived=false', async () => {
    // completed + 零 WU：progress 是历史快照，实时重算为空集 → 归档标志
    const s1 = await getDeliveryStatus('proj-1', undefined, makeDeps({
      project: project({ status: 'completed', progress: 100, completedAt: '2026-07-30T00:00:00Z' }),
      snapshots: [],
    }));
    expect(s1!.archived).toBe(true);

    // 已交付的 completed 项目（deliveredAt 落档）+ 零 WU → 同样归档
    const s2 = await getDeliveryStatus('proj-1', undefined, makeDeps({
      project: project({ status: 'completed', progress: 100, deliveredAt: '2026-07-30T01:00:00Z' }),
      snapshots: [],
    }));
    expect(s2!.archived).toBe(true);

    // deliveredAt 不是终态代理（deliverProject 不翻 status；in_review → cancelled 合法）：
    // cancelled + deliveredAt + 零 WU → 不置标志（评审回归：误触发路径）
    const s2b = await getDeliveryStatus('proj-1', undefined, makeDeps({
      project: project({ status: 'cancelled', deliveredAt: '2026-07-30T01:00:00Z' }),
      snapshots: [],
    }));
    expect(s2b!.archived).toBe(false);

    // 在途项目零 WU：真无任务，不是归档 → 不置标志
    const s3 = await getDeliveryStatus('proj-1', undefined, makeDeps({ snapshots: [] }));
    expect(s3!.archived).toBe(false);

    // completed 但仍有 WU 在册：实时口径有效 → 不置标志
    const ready = wu({ metadataObj: fullEvidence });
    const s4 = await getDeliveryStatus('proj-1', undefined, makeDeps({
      project: project({ status: 'completed', progress: 100, completedAt: '2026-07-30T00:00:00Z' }),
      snapshots: [ready],
    }));
    expect(s4!.archived).toBe(false);
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
    const ready = wu({ reqId: null, metadataObj: { pmoId: 'proj-1', ...fullEvidence } });
    const other = wu({ reqId: null, metadataObj: { pmoId: 'proj-2', attestations: {} } });
    const s = await getDeliveryStatus('proj-1', undefined, makeDeps({ reqs: [], snapshots: [ready, other] }));
    expect(s!.wu).toEqual({ total: 1, finished: 1, inFlight: 0, byStatus: { unassigned: 0, active: 0, inReview: 0, blocked: 0 } }); // proj-2 的 WU 不计入
    expect(s!.missing).not.toContain('无关联任务');
    expect(s!.deliverable).toBe(true);
  });

  it('pmoId 回退：证据缺口如实列出（缺 L1 不因回退豁免）；坏 metadata 容错', async () => {
    const gaps = wu({ reqId: null, metadataObj: { pmoId: 'proj-1', attestations: { l2: att('agent-review'), l3: att('human-confirm') } } });
    const broken = wu({ reqId: null, metadata: '{broken-json' });
    const s = await getDeliveryStatus('proj-1', undefined, makeDeps({ reqs: [], snapshots: [gaps, broken] }));
    expect(s!.wu.total).toBe(1);
    expect(s!.deliverable).toBe(false);
    expect(s!.evidence.l1Missing).toEqual([gaps.id]); // task 类型缺 l1
    expect(s!.missing.join(' ')).toContain('缺自动验证');
    expect(s!.missing).not.toContain('无关联任务');
  });
});

describe('deliverProject（PMO-b 交付守卫）', () => {
  const readyWu = () => wu({ metadataObj: fullEvidence });

  it('branch-only → 拒绝并附分支名（不碰合并链路）', async () => {
    const deps = makeDeps({ project: project({ deliveryPolicy: 'branch-only' }), snapshots: [readyWu()] });
    const r = await deliverProject('proj-1', 'Alice', undefined, deps);
    expect(r.delivered).toBe(false);
    expect(r.reason).toBe('branch-only');
    expect(mockExecSh).not.toHaveBeenCalled();
  });

  it('auto-merge 缺证据 → not-ready 硬拒（附缺口），不误报交付失败', async () => {
    const deps = makeDeps({ project: project({ deliveryPolicy: 'auto-merge' }), snapshots: [wu({ metadataObj: {} })] });
    const r = await deliverProject('proj-1', 'Alice', undefined, deps);
    expect(r).toMatchObject({ delivered: false, reason: 'not-ready' });
    expect(mockExecSh).not.toHaveBeenCalled();
    expect(deps.recordLearningOutcome).not.toHaveBeenCalled();
  });

  it('auto-merge 缺仓库 → no-repo 并回写受影响工作', async () => {
    const ready = readyWu();
    const deps = makeDeps({
      project: project({ deliveryPolicy: 'auto-merge', gitRepo: null }),
      snapshots: [ready],
    });
    const r = await deliverProject('proj-1', 'Alice', undefined, deps);
    expect(r).toMatchObject({ delivered: false, reason: 'no-repo' });
    expect(deps.recordLearningOutcome).toHaveBeenCalledWith(ready.id, expect.objectContaining({
      kind: 'delivery-failed', workUnitIds: [ready.id],
    }));
  });

  it('代码 WU Mandate 撤销 → 交付交回授权，零 Git/台账写入', async () => {
    const revoked = readyWu();
    revoked.mandate = { ...revoked.mandate!, revokedAt: '2026-07-29T02:00:00Z' };
    const deps = makeDeps({ project: project({ deliveryPolicy: 'auto-merge' }), snapshots: [revoked] });

    const result = await deliverProject('proj-1', 'operator-1', undefined, deps);

    expect(result).toMatchObject({ delivered: false, reason: 'mandate-rejected' });
    expect(mockExecSh).not.toHaveBeenCalled();
    expect(deps.updateProject).not.toHaveBeenCalled();
  });

  it('项目实际交付腿不在 WU Mandate 中 → 不合并项目目标', async () => {
    const deps = makeDeps({
      project: project({ deliveryPolicy: 'auto-merge', gitBranch: 'pmo/other' }),
      snapshots: [readyWu()],
    });

    const result = await deliverProject('proj-1', 'operator-1', undefined, deps);

    expect(result).toMatchObject({ delivered: false, reason: 'mandate-rejected' });
    expect(mockExecSh).not.toHaveBeenCalled();
  });

  it.each(['queued', 'running'])('同腿 WU merge %s → merge-pending，零 Git 写', async state => {
    const pending = wu({
      status: 'in_review', completedAt: null,
      metadataObj: { mergeIntent: { id: 'merge-1', state, requestedAt: '2026-07-29T00:40:00Z' } },
    });
    const deps = makeDeps({ project: project({ deliveryPolicy: 'auto-merge' }), snapshots: [pending] });
    const r = await deliverProject('proj-1', 'Alice', undefined, deps);
    expect(r).toMatchObject({ delivered: false, reason: 'merge-pending' });
    expect(deps.updateProject).not.toHaveBeenCalled();
    expect(mockExecSh).not.toHaveBeenCalled();
  });

  it('已合并但目标验证未结束 → merge-pending，不能读取半成品状态交付', async () => {
    const pending = wu({
      status: 'in_review', completedAt: null,
      metadataObj: {
        mergeIntent: { id: 'merge-1', state: 'running', requestedAt: '2026-07-29T00:40:00Z' },
        mergeReceipt: { ...mergeReceipt, verification: { status: 'not-run', ran: [] } },
      },
    });
    const r = await deliverProject('proj-1', 'Alice', undefined, makeDeps({
      project: project({ deliveryPolicy: 'auto-merge' }), snapshots: [pending],
    }));
    expect(r).toMatchObject({ delivered: false, reason: 'merge-pending' });
  });

  it('交付锁内 fresh 重读发现 queued intent → 拒绝，不能用初次 ready 快照合并', async () => {
    mockExecSh.mockImplementation(async (cmd: string) => {
      if (cmd.includes('abbrev-ref')) return { stdout: 'master\n', stderr: '' };
      if (cmd.includes('rev-parse HEAD')) return { stdout: 'feedbeef\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const pending = wu({
      status: 'in_review', completedAt: null,
      metadataObj: { mergeIntent: { id: 'merge-1', state: 'queued', requestedAt: '2026-07-29T00:40:00Z' } },
    });
    const deps = makeDeps({ project: project({ deliveryPolicy: 'auto-merge' }) });
    deps.getIndex = vi.fn()
      .mockResolvedValueOnce([readyWu()])
      .mockResolvedValueOnce([pending]);
    const r = await deliverProject('proj-1', 'Alice', undefined, deps);
    expect(r).toMatchObject({ delivered: false, reason: 'merge-pending' });
    expect(deps.getIndex).toHaveBeenCalledTimes(2);
    expect(mockExecSh).not.toHaveBeenCalled();
  });

  it('顶层与嵌套腿危险分支均在 rev-parse/diff 前零子进程拒绝', async () => {
    for (const branch of ['feature";id', 'feature$(id)', 'feature`id`', 'feature;id', 'feature\nid', '--upload-pack=id']) {
      const topLevel = await deliverProject('proj-1', 'Alice', undefined, makeDeps({
        project: project({ deliveryPolicy: 'auto-merge', gitBranch: branch }), snapshots: [readyWu()],
      }));
      expect(topLevel, branch).toMatchObject({ delivered: false, reason: 'conflict' });

      const nested = await deliverProject('proj-1', 'Alice', undefined, makeDeps({
        project: project({
          deliveryPolicy: 'auto-merge', gitRepo: null, gitBranch: null,
          deliveries: [
            { gitRepo: '/repo/a', branch, status: 'pending' },
            { gitRepo: '/repo/b', branch: 'PMO-11-b', status: 'pending' },
          ],
        }),
        snapshots: [wu({ metadataObj: {
          workspaceRoot: '/repo/a', ...fullEvidence,
        } })],
      }));
      expect(nested, branch).toMatchObject({ delivered: false, reason: 'conflict' });
      expect(mockExecSh, branch).not.toHaveBeenCalled();
      expect(mockExecFile, branch).not.toHaveBeenCalled();
    }
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
    expect(mockExecFile).toHaveBeenCalledWith(
      'git', ['-C', '/repo/x', 'merge', '--no-ff', '-m', 'deliver: PMO-11', '--', 'PMO-11'],
      expect.objectContaining({ cwd: '/repo/x' }), expect.any(Function),
    );
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
    const ready = readyWu();
    const deps = makeDeps({ project: project({ deliveryPolicy: 'auto-merge' }), snapshots: [ready] });
    const r = await deliverProject('proj-1', 'Alice', undefined, deps);
    expect(r).toMatchObject({ delivered: false, reason: 'conflict', conflictFiles: ['a.ts', 'b.ts'] });
    expect(deps.recordLearningOutcome).toHaveBeenCalledWith(ready.id, {
      eventId: expect.stringContaining('delivery-failed:proj-1:conflict:PMO-11:'),
      kind: 'delivery-failed',
      workUnitIds: [ready.id],
    });
  });

  it('同 WU 集合的新候选 head 再次冲突时使用不同失败事件身份', async () => {
    let sourceHead = 'a'.repeat(40);
    mockExecSh.mockImplementation(async (cmd: string) => {
      if (cmd.includes('abbrev-ref')) return { stdout: 'master\n', stderr: '' };
      if (cmd.includes('rev-parse --verify')) return { stdout: `${sourceHead}\n`, stderr: '' };
      if (cmd.includes('merge --no-ff')) throw new Error('CONFLICT (content): Merge conflict in a.ts');
      return { stdout: '', stderr: '' };
    });
    const deps = makeDeps({ project: project({ deliveryPolicy: 'auto-merge' }), snapshots: [readyWu()] });

    await deliverProject('proj-1', 'Alice', undefined, deps);
    sourceHead = 'b'.repeat(40);
    await deliverProject('proj-1', 'Alice', undefined, deps);

    const eventIds = deps.recordLearningOutcome.mock.calls.map(call => call[1].eventId);
    expect(eventIds).toHaveLength(2);
    expect(eventIds[0]).not.toBe(eventIds[1]);
  });

  it('#469：deliver 成功 → 频道播报（pmoNumber + commit 短哈希 + 腿数 + 操作人），meta 带 pmoId/atHuman', async () => {
    mockExecSh.mockImplementation(async (cmd: string) => {
      if (cmd.includes('abbrev-ref')) return { stdout: 'master\n', stderr: '' };
      if (cmd.includes('rev-parse HEAD')) return { stdout: 'feedbeef1234567\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const tmpStore = new FileStore(fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'pmo-deliver-notify-')));
    const deps = makeDeps({ project: project({ deliveryPolicy: 'auto-merge', channelId: 'ch-1' }), snapshots: [readyWu()] });
    const r = await deliverProject('proj-1', 'Alice', tmpStore, deps);

    expect(r.delivered).toBe(true);
    const msgs = await tmpStore.queryMessages('ch-1', {});
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toContain('PMO-11');
    expect(msgs[0].content).toContain('feedbee'); // 短哈希
    expect(msgs[0].content).toContain('1 条交付腿');
    expect(msgs[0].content).toContain('Alice');
    const meta = typeof msgs[0].meta === 'string' ? JSON.parse(msgs[0].meta) : msgs[0].meta;
    expect(meta).toMatchObject({ pmoId: 'proj-1', atHuman: true });
  });

  it('#469：无 channelId 项目 deliver 成功 → 不发帖不炸（播报 best-effort）', async () => {
    mockExecSh.mockImplementation(async (cmd: string) => {
      if (cmd.includes('abbrev-ref')) return { stdout: 'master\n', stderr: '' };
      if (cmd.includes('rev-parse HEAD')) return { stdout: 'feedbeef\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const deps = makeDeps({ project: project({ deliveryPolicy: 'auto-merge' }), snapshots: [readyWu()] });
    const r = await deliverProject('proj-1', 'Alice', undefined, deps);
    expect(r.delivered).toBe(true);
  });
});

describe('markProjectDelivered（#469 branch-only 人工落档）', () => {
  const COMMIT = 'c0ffee1234567890';

  it('项目不存在 → not-found', async () => {
    const r = await markProjectDelivered('proj-x', 'Alice', COMMIT, undefined, makeDeps({ project: null }));
    expect(r).toMatchObject({ marked: false, reason: 'not-found' });
  });

  it('auto-merge 项目 → not-branch-only（应走 deliver 合并），不落档', async () => {
    const deps = makeDeps({ project: project({ deliveryPolicy: 'auto-merge' }) });
    const r = await markProjectDelivered('proj-1', 'Alice', COMMIT, undefined, deps);
    expect(r).toMatchObject({ marked: false, reason: 'not-branch-only' });
    expect(deps.updateProject).not.toHaveBeenCalled();
  });

  it('已落档（deliveredAt 非空）→ already-delivered，不重复写', async () => {
    const deps = makeDeps({ project: project({ deliveryPolicy: 'branch-only', deliveredAt: '2026-08-01T00:00:00Z' }) });
    const r = await markProjectDelivered('proj-1', 'Alice', COMMIT, undefined, deps);
    expect(r).toMatchObject({ marked: false, reason: 'already-delivered' });
    expect(deps.updateProject).not.toHaveBeenCalled();
  });

  it('Mandate 撤销 → 人工交付落档同样拒绝', async () => {
    const revoked = wu({ metadataObj: fullEvidence });
    revoked.mandate = { ...revoked.mandate!, revokedAt: '2026-07-29T02:00:00Z' };
    const deps = makeDeps({ project: project({ deliveryPolicy: 'branch-only' }), snapshots: [revoked] });

    const result = await markProjectDelivered('proj-1', 'operator-1', COMMIT, undefined, deps);

    expect(result).toMatchObject({ marked: false, reason: 'mandate-rejected' });
    expect(deps.updateProject).not.toHaveBeenCalled();
  });

  it('branch-only 同腿仍有 queued merge → merge-pending，不落人工交付回执', async () => {
    const pending = wu({
      status: 'in_review', completedAt: null,
      metadataObj: { mergeIntent: { id: 'merge-1', state: 'queued', requestedAt: '2026-07-29T00:40:00Z' } },
    });
    const deps = makeDeps({ project: project({ deliveryPolicy: 'branch-only' }), snapshots: [pending] });
    const r = await markProjectDelivered('proj-1', 'Alice', COMMIT, undefined, deps);
    expect(r).toMatchObject({ marked: false, reason: 'merge-pending' });
    expect(deps.updateProject).not.toHaveBeenCalled();
  });

  it('done WU 的历史 running intent 不阻断人工交付落档', async () => {
    const completed = wu({ metadataObj: {
      ...fullEvidence,
      mergeIntent: { id: 'merge-1', state: 'running', requestedAt: '2026-07-29T00:40:00Z' },
    } });
    const deps = makeDeps({ project: project({ deliveryPolicy: 'branch-only' }), snapshots: [completed] });
    const r = await markProjectDelivered('proj-1', 'Alice', COMMIT, undefined, deps);
    expect(r).toMatchObject({ marked: true });
  });

  it('#721 证据不齐 → 与 auto-merge 一样 not-ready，不能人工落档绕过', async () => {
    const deps = makeDeps({
      project: project({ deliveryPolicy: 'branch-only' }),
      snapshots: [wu({ metadataObj: {} })],
    });
    const r = await markProjectDelivered('proj-1', 'Alice', COMMIT, undefined, deps);
    expect(r).toMatchObject({ marked: false, reason: 'not-ready' });
    expect(r.detail).toContain('缺自动验证');
    expect(deps.updateProject).not.toHaveBeenCalled();
  });

  it('branch-only 未交付且证据齐 → 写 deliveredAt/deliveredBy/deliverCommit + 频道播报', async () => {
    const tmpStore = new FileStore(fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'pmo-mark-delivered-')));
    const deps = makeDeps({
      project: project({ deliveryPolicy: 'branch-only', channelId: 'ch-9' }),
      snapshots: [wu({ metadataObj: fullEvidence })],
    });
    const r = await markProjectDelivered('proj-1', 'Bob', COMMIT, tmpStore, deps);

    expect(r).toMatchObject({ marked: true, deliverCommit: COMMIT });
    expect(deps.updateProject).toHaveBeenCalledWith('proj-1', expect.objectContaining({
      deliveredBy: 'Bob',
      deliverCommit: COMMIT,
    }));
    const patch = deps.updateProject.mock.calls[0][1] as Record<string, unknown>;
    expect(typeof patch.deliveredAt).toBe('string');

    const msgs = await tmpStore.queryMessages('ch-9', {});
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toContain('PMO-11');
    expect(msgs[0].content).toContain('c0ffee1'); // 短哈希
    expect(msgs[0].content).toContain('Bob');
  });
});
