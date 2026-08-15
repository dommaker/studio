// 收口守卫链单测（completion-gates）：纯 ctx 对象 + 注入伪依赖，无 vi.mock 模块工厂。
// 覆盖：三条守卫各自的触发/跳过/降级路径、守卫优先级（commit → child → verify）、
// hint 文案、l1 台账形状、verifyFailCount ≥3 → verifyBlocked、no-commit 计数/提醒。
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  runCompletionGuards,
  hasUncommittedChanges,
  readHeadHash,
  parseWuGitLog,
  loadCompletionCheckersConfig,
  type CompletionCheckerFns,
  type CompletionCheckersConfig,
  type CompletionGuardDeps,
  type SoftCheckCommitInput,
  type SoftCheckEvent,
} from '../loop/completion-gates';
import type { WorkUnitData, WorkUnitMetadata } from '../../workunit/workunit.service.js';

const COMMIT_HINT = '有未提交改动，请先 git add/commit 再报告完成';
const ROLE_ID = 'role-dev';

function makeWu(overrides: Partial<WorkUnitData> = {}): WorkUnitData {
  return {
    id: 'wu-1', parentId: null, type: 'task', scope: '实现功能', assigneeId: 'instance-1',
    status: 'active', failureType: null, retryCount: 0, timeoutAt: null,
    channelId: null, projectPath: null, workspaceId: null, metadata: null,
    createdAt: new Date(), updatedAt: new Date(), claimedAt: null, completedAt: null,
    ...overrides,
  };
}

/** 默认伪依赖：cwd 可解析、worktree 干净、无子任务、验证零命令通过 */
function makeDeps(overrides: Partial<CompletionGuardDeps> = {}): CompletionGuardDeps & {
  resolveExecutionCwd: ReturnType<typeof vi.fn>;
  listUnfinishedChildren: ReturnType<typeof vi.fn>;
  hasUncommittedChanges: ReturnType<typeof vi.fn>;
  readHeadHash: ReturnType<typeof vi.fn>;
  runVerification: ReturnType<typeof vi.fn>;
} {
  return {
    resolveExecutionCwd: vi.fn().mockResolvedValue('/repo/wt'),
    listUnfinishedChildren: vi.fn().mockResolvedValue([]),
    hasUncommittedChanges: vi.fn().mockReturnValue(false),
    readHeadHash: vi.fn().mockReturnValue('h1'),
    runVerification: vi.fn().mockResolvedValue({ ran: [], source: 'convention' }),
    ...overrides,
  } as ReturnType<typeof makeDeps>;
}

function ctxOf(wu: WorkUnitData, metadata: WorkUnitMetadata, action: 'progress' | 'complete' | 'need_input' | 'delegate' | 'failed' = 'complete') {
  return { wu, wuId: wu.id, metadata, action, roleId: ROLE_ID };
}

describe('completion-gates: §10.5 提交守卫', () => {
  it('COMPLETE + 未提交改动 → 降级 progress + commitGuardHint；后续守卫不再触发', async () => {
    const deps = makeDeps({ hasUncommittedChanges: vi.fn().mockReturnValue(true) });
    const out = await runCompletionGuards(ctxOf(makeWu(), {}), deps);

    expect(out.action).toBe('progress');
    expect(out.guardUpdates.commitGuardHint).toBe(COMMIT_HINT);
    // 优先级：commit 降级后 child/verify 不再触发
    expect(deps.listUnfinishedChildren).not.toHaveBeenCalled();
    expect(deps.runVerification).not.toHaveBeenCalled();
    // 降级后同轮进入 PROGRESS 无提交监视（首次记录 HEAD）
    expect(out.guardUpdates.lastCommitHash).toBe('h1');
    expect(out.guardUpdates.noCommitSteps).toBe(0);
  });

  it('COMPLETE + 干净 worktree → 不降级、不写 hint', async () => {
    const deps = makeDeps();
    const out = await runCompletionGuards(ctxOf(makeWu(), {}), deps);

    expect(out.action).toBe('complete');
    expect(out.guardUpdates.commitGuardHint).toBeUndefined();
  });

  it('review WU 整体豁免：不解析 cwd、不碰 git', async () => {
    const deps = makeDeps();
    const out = await runCompletionGuards(ctxOf(makeWu({ type: 'review' }), {}), deps);

    expect(deps.resolveExecutionCwd).not.toHaveBeenCalled();
    expect(deps.hasUncommittedChanges).not.toHaveBeenCalled();
    expect(out.action).toBe('complete');
  });

  it('cwd 解析为 null → 提交守卫静默跳过', async () => {
    const deps = makeDeps({ resolveExecutionCwd: vi.fn().mockResolvedValue(null) });
    const out = await runCompletionGuards(ctxOf(makeWu(), {}), deps);

    expect(deps.hasUncommittedChanges).not.toHaveBeenCalled();
    expect(deps.readHeadHash).not.toHaveBeenCalled();
    expect(out.action).toBe('complete');
  });

  it('非 complete/progress 的 action（need_input）：提交守卫不拦截也不监视', async () => {
    const deps = makeDeps();
    const out = await runCompletionGuards(ctxOf(makeWu(), {}, 'need_input'), deps);

    expect(deps.hasUncommittedChanges).not.toHaveBeenCalled();
    expect(deps.readHeadHash).not.toHaveBeenCalled();
    expect(out.action).toBe('need_input');
  });
});

describe('completion-gates: PROGRESS 无提交监视', () => {
  it('HEAD 不变 → noCommitSteps 累计；新提交 → 归零并更新 hash', async () => {
    const deps = makeDeps();

    const same = await runCompletionGuards(
      ctxOf(makeWu(), { lastCommitHash: 'h1', noCommitSteps: 1 }, 'progress'), deps);
    expect(same.guardUpdates.noCommitSteps).toBe(2);
    expect(same.guardUpdates.lastCommitHash).toBeUndefined();
    expect(same.notices.noCommit).toBe(false);

    const fresh = await runCompletionGuards(
      ctxOf(makeWu(), { lastCommitHash: 'h0', noCommitSteps: 2 }, 'progress'),
      makeDeps({ readHeadHash: vi.fn().mockReturnValue('h9') }));
    expect(fresh.guardUpdates.lastCommitHash).toBe('h9');
    expect(fresh.guardUpdates.noCommitSteps).toBe(0);
    expect(fresh.notices.noCommit).toBe(false);
  });

  it('连续第 3 步无新提交 → noCommit notice + 计数归零', async () => {
    const deps = makeDeps();
    const out = await runCompletionGuards(
      ctxOf(makeWu(), { lastCommitHash: 'h1', noCommitSteps: 2 }, 'progress'), deps);

    expect(out.notices.noCommit).toBe(true);
    expect(out.guardUpdates.noCommitSteps).toBe(0);
  });

  it('HEAD 读取失败（null）→ 静默跳过（metadata 不变、无提醒）', async () => {
    const deps = makeDeps({ readHeadHash: vi.fn().mockReturnValue(null) });
    const out = await runCompletionGuards(
      ctxOf(makeWu(), { lastCommitHash: 'h1', noCommitSteps: 2 }, 'progress'), deps);

    expect(out.guardUpdates.noCommitSteps).toBeUndefined();
    expect(out.guardUpdates.lastCommitHash).toBeUndefined();
    expect(out.notices.noCommit).toBe(false);
  });
});

describe('completion-gates: §6-2 子任务守卫', () => {
  it('COMPLETE + 未完结子任务 → 降级 progress + childGuardHint（id 全列出）', async () => {
    const deps = makeDeps({ listUnfinishedChildren: vi.fn().mockResolvedValue(['c1', 'c2']) });
    const out = await runCompletionGuards(ctxOf(makeWu(), {}), deps);

    expect(out.action).toBe('progress');
    expect(out.guardUpdates.childGuardHint)
      .toBe('存在未完结子任务（c1, c2），等待其全部完成后再报告 COMPLETE');
    // 优先级：child 降级后 verify 不再触发
    expect(deps.runVerification).not.toHaveBeenCalled();
  });

  it('子任务全部完结 → 不降级、不写 hint', async () => {
    const deps = makeDeps();
    const out = await runCompletionGuards(ctxOf(makeWu(), {}), deps);

    expect(deps.listUnfinishedChildren).toHaveBeenCalledWith('wu-1');
    expect(out.action).toBe('complete');
    expect(out.guardUpdates.childGuardHint).toBeUndefined();
  });
});

describe('completion-gates: B3b-i 自动验证守卫', () => {
  it('跳过条件：非代码类（analysis）即使有 worktreePath 也不跑', async () => {
    const deps = makeDeps();
    const out = await runCompletionGuards(
      ctxOf(makeWu({ type: 'analysis' }), { worktreePath: '/repo/wt' }), deps);

    expect(deps.runVerification).not.toHaveBeenCalled();
    expect(out.notices.verifyGuardRan).toBe(false);
    expect(out.action).toBe('complete');
  });

  it('跳过条件：代码类但无 worktreePath → 不跑', async () => {
    const deps = makeDeps();
    const out = await runCompletionGuards(ctxOf(makeWu(), {}), deps);

    expect(deps.runVerification).not.toHaveBeenCalled();
    expect(out.notices.verifyGuardRan).toBe(false);
  });

  it('验证失败 → 降级 progress：verifyFailCount++、hint 含失败命令+输出尾部、l1 rejected 台账', async () => {
    const deps = makeDeps({
      runVerification: vi.fn().mockResolvedValue({
        ran: [], source: 'override',
        failure: { command: 'make check', tail: 'boom-output' },
      }),
    });
    const out = await runCompletionGuards(
      ctxOf(makeWu(), { worktreePath: '/repo/wt', verifyFailCount: 1 }), deps);

    expect(out.action).toBe('progress');
    expect(out.notices.verifyGuardRan).toBe(true);
    expect(out.notices.verifyBlocked).toBe(false);
    expect(out.guardUpdates.verifyFailCount).toBe(2);
    expect(out.guardUpdates.verifyFailHint).toBe(
      '自动验证未通过（第 2 次），请先修复再报告完成\n失败命令: make check\n输出尾部:\nboom-output');
    const l1 = out.guardUpdates.attestations?.l1;
    expect(l1).toMatchObject({
      verdict: 'rejected', by: ROLE_ID, kind: 'verify', summary: '失败命令: make check',
    });
    expect(typeof l1?.at).toBe('string');
    // 失败不留 verifyReport（metrics 按 verifyReport 存在计通过）
    expect(out.guardUpdates.verifyReport).toBeUndefined();
  });

  it('verifyFailCount 到 3 → verifyBlocked', async () => {
    const deps = makeDeps({
      runVerification: vi.fn().mockResolvedValue({
        ran: [], source: 'override', failure: { command: 'make check', tail: 'x' },
      }),
    });
    const out = await runCompletionGuards(
      ctxOf(makeWu(), { worktreePath: '/repo/wt', verifyFailCount: 2 }), deps);

    expect(out.guardUpdates.verifyFailCount).toBe(3);
    expect(out.notices.verifyBlocked).toBe(true);
  });

  it('验证全绿 → 不降级：verifyFailCount 归零、verifyReport + l1 approved 台账 + verifyPassed 简报', async () => {
    const deps = makeDeps({
      runVerification: vi.fn().mockResolvedValue({ ran: ['make check', './ci.sh'], source: 'override' }),
    });
    const out = await runCompletionGuards(
      ctxOf(makeWu(), { worktreePath: '/repo/wt', verifyFailCount: 2 }), deps);

    expect(out.action).toBe('complete');
    expect(out.notices.verifyGuardRan).toBe(true);
    expect(out.notices.verifyBlocked).toBe(false);
    expect(out.guardUpdates.verifyFailCount).toBe(0);
    expect(out.guardUpdates.verifyReport).toMatchObject({
      commands: ['make check', './ci.sh'], source: 'override',
    });
    expect(typeof out.guardUpdates.verifyReport?.passedAt).toBe('string');
    const l1 = out.guardUpdates.attestations?.l1;
    expect(l1).toMatchObject({
      verdict: 'approved', by: ROLE_ID, kind: 'verify', summary: 'make check；./ci.sh',
    });
    expect(out.notices.verifyPassed).toBe('✅ 自动验证通过（2 条）：make check；./ci.sh');
  });

  it('全绿但零命令可跑（ran=[]）→ 只归零 verifyFailCount，不写报告/台账/简报', async () => {
    const deps = makeDeps();
    const out = await runCompletionGuards(
      ctxOf(makeWu(), { worktreePath: '/repo/wt', verifyFailCount: 1 }), deps);

    expect(out.action).toBe('complete');
    expect(out.guardUpdates.verifyFailCount).toBe(0);
    expect(out.guardUpdates.verifyReport).toBeUndefined();
    expect(out.guardUpdates.attestations).toBeUndefined();
    expect(out.notices.verifyPassed).toBeNull();
  });

  it('台账写入保留既有其他层（l2 不被覆盖）', async () => {
    const existingL2 = { verdict: 'approved' as const, by: 'role-rev', at: '2026-08-01T00:00:00Z', kind: 'review' as const };
    const deps = makeDeps({
      runVerification: vi.fn().mockResolvedValue({ ran: ['make check'], source: 'override' }),
    });
    const out = await runCompletionGuards(
      ctxOf(makeWu(), { worktreePath: '/repo/wt', attestations: { l2: existingL2 } }), deps);

    expect(out.guardUpdates.attestations?.l2).toEqual(existingL2);
    expect(out.guardUpdates.attestations?.l1?.verdict).toBe('approved');
  });
});

describe('completion-gates: 默认 git 探针（真实实现，失败静默跳过）', () => {
  it('非 git 目录 → hasUncommittedChanges=false、readHeadHash=null', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-plain-'));
    try {
      expect(hasUncommittedChanges(plain)).toBe(false);
      expect(readHeadHash(plain)).toBeNull();
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});

// ─── T7-E2（#161）软观测段：mock git/配置/harness 函数，纯 ctx 驱动 ───
describe('completion-gates: T7-E2 软观测段', () => {
  const SOFT_META: WorkUnitMetadata = { worktreePath: '/repo/wt', worktreeBaseBranch: 'main' };
  const COMMITS: SoftCheckCommitInput[] = [
    { sha: 'aaaaaaa1', subject: 'phase(x): a', body: '', files: ['src/a.ts'], isMerge: false },
  ];

  function makeSoftDeps(
    fnsOverrides: Partial<CompletionCheckerFns> | null,
    opts: { commits?: SoftCheckCommitInput[] | null; config?: CompletionCheckersConfig } = {},
  ) {
    const fns: CompletionCheckerFns = {
      verifyTddChain: vi.fn().mockReturnValue({
        checker: 'tdd-chain', verdict: 'pass', commits: [{ sha: 'aaaaaaa1', verdict: 'pass' }],
      }),
      verifyPhaseFormat: vi.fn().mockReturnValue({
        checker: 'phase-format', verdict: 'pass', commits: [{ sha: 'aaaaaaa1', verdict: 'pass' }],
      }),
      verifyContractPresence: vi.fn().mockReturnValue({
        checker: 'contract-presence', verdict: 'skip', detail: '类型 task 无 contracts 表项',
      }),
      ...(fnsOverrides ?? {}),
    };
    const events: SoftCheckEvent[] = [];
    const deps = makeDeps({
      loadCompletionCheckers: vi.fn().mockResolvedValue(fnsOverrides === null ? null : fns),
      readWuCommits: vi.fn().mockReturnValue(opts.commits === undefined ? COMMITS : opts.commits),
      loadCompletionCheckersConfig: vi.fn().mockReturnValue(opts.config ?? {}),
      writeSoftCheckEvent: vi.fn((e: SoftCheckEvent) => { events.push(e); }),
    });
    return { deps, fns, events };
  }

  it('违规 → violation 事件 + processCheckHint；不阻断 COMPLETE', async () => {
    const { deps, events } = makeSoftDeps({
      verifyTddChain: vi.fn().mockReturnValue({
        checker: 'tdd-chain', verdict: 'violation',
        commits: [{ sha: 'aaaaaaa1', verdict: 'violation', reason: '缺 Tested-By trailer 且未声明 Tests: none' }],
      }),
    });
    const out = await runCompletionGuards(ctxOf(makeWu(), SOFT_META), deps);

    expect(out.action).toBe('complete'); // 软观测不降级
    expect(events).toContainEqual(expect.objectContaining({
      wuId: 'wu-1', checker: 'tdd-chain', verdict: 'violation',
    }));
    expect(events.find(e => e.checker === 'tdd-chain')?.detail).toContain('缺 Tested-By');
    expect(out.guardUpdates.processCheckHint).toContain('[tdd-chain]');
    expect(out.guardUpdates.processCheckHint).toContain('缺 Tested-By');
  });

  it('豁免（Tests: none）→ waiver 事件，不写 hint', async () => {
    const { deps, events } = makeSoftDeps({
      verifyTddChain: vi.fn().mockReturnValue({
        checker: 'tdd-chain', verdict: 'pass',
        commits: [{ sha: 'aaaaaaa1', verdict: 'waiver', reason: 'Tests: none 显式豁免' }],
      }),
    });
    const out = await runCompletionGuards(ctxOf(makeWu(), SOFT_META), deps);

    expect(events).toContainEqual(expect.objectContaining({ checker: 'tdd-chain', verdict: 'waiver' }));
    expect(out.guardUpdates.processCheckHint).toBeUndefined();
    expect(out.action).toBe('complete');
  });

  it('全合规 → pass 事件在场（两 commit checker 各一条）', async () => {
    const { deps, events } = makeSoftDeps({});
    const out = await runCompletionGuards(ctxOf(makeWu(), SOFT_META), deps);

    expect(events).toContainEqual(expect.objectContaining({ checker: 'tdd-chain', verdict: 'pass' }));
    expect(events).toContainEqual(expect.objectContaining({ checker: 'phase-format', verdict: 'pass' }));
    expect(out.guardUpdates.processCheckHint).toBeUndefined();
  });

  it('fail-open：harness 函数缺席（包未加载/未发版）→ 整体静默跳过，不阻断 COMPLETE', async () => {
    const { deps, events } = makeSoftDeps(null);
    const out = await runCompletionGuards(ctxOf(makeWu(), SOFT_META), deps);

    expect(out.action).toBe('complete');
    expect(events).toHaveLength(0);
    expect(out.guardUpdates.processCheckHint).toBeUndefined();
  });

  it('fail-open：git log 故障 → commit 两 checker 跳过不记事件，contract-presence 仍跑', async () => {
    const { deps, fns, events } = makeSoftDeps({}, { commits: null });
    const out = await runCompletionGuards(ctxOf(makeWu(), SOFT_META), deps);

    expect(fns.verifyTddChain).not.toHaveBeenCalled();
    expect(fns.verifyPhaseFormat).not.toHaveBeenCalled();
    expect(fns.verifyContractPresence).toHaveBeenCalled();
    expect(events).toHaveLength(0); // contract-presence 无表项 skip 不记事件
    expect(out.action).toBe('complete');
  });

  it('缺 yml 段 = 默认全开：config {} 时 commit 两 checker 均被调用', async () => {
    const { deps, fns } = makeSoftDeps({}, { config: {} });
    await runCompletionGuards(ctxOf(makeWu(), SOFT_META), deps);

    expect(fns.verifyTddChain).toHaveBeenCalledWith(COMMITS, {});
    expect(fns.verifyPhaseFormat).toHaveBeenCalledWith(COMMITS, {});
  });

  it('圈定口径：非代码类型（analysis）→ 不拉提交集；contracts 无表项 → contract-presence skip 不记事件', async () => {
    const { deps, fns, events } = makeSoftDeps({});
    const out = await runCompletionGuards(ctxOf(makeWu({ type: 'analysis' }), SOFT_META), deps);

    expect(deps.readWuCommits).not.toHaveBeenCalled();
    expect(fns.verifyTddChain).not.toHaveBeenCalled();
    expect(fns.verifyContractPresence).toHaveBeenCalled();
    expect(events).toHaveLength(0);
    expect(out.action).toBe('complete');
  });

  it('圈定口径：review 型契约缺失（contracts 含 review + 无 reviewReport）→ violation 事件 + hint', async () => {
    const { deps, fns, events } = makeSoftDeps(
      {
        verifyContractPresence: vi.fn().mockReturnValue({
          checker: 'contract-presence', verdict: 'violation', detail: '类型 review 契约标记缺失',
        }),
      },
      { config: { contracts: ['review'] } },
    );
    const out = await runCompletionGuards(ctxOf(makeWu({ type: 'review' }), {}), deps);

    expect(fns.verifyContractPresence).toHaveBeenCalledWith('review', { reviewReport: undefined }, { contracts: ['review'] });
    expect(events).toContainEqual(expect.objectContaining({ checker: 'contract-presence', verdict: 'violation' }));
    expect(out.guardUpdates.processCheckHint).toContain('[contract-presence]');
    expect(out.action).toBe('complete');
  });

  it('action 已被前面守卫降级 → 软观测段不跑', async () => {
    const { deps } = makeSoftDeps({});
    deps.hasUncommittedChanges.mockReturnValue(true);
    const out = await runCompletionGuards(ctxOf(makeWu(), SOFT_META), deps);

    expect(out.action).toBe('progress');
    expect(deps.loadCompletionCheckers).not.toHaveBeenCalled();
  });
});

describe('completion-gates: T7-E2 parseWuGitLog（git log %(trailers) 输出解析）', () => {
  it('sha/subject/parents/trailer/文件清单分段；merge commit 按 %P 父数标记；输出反转为升序', () => {
    const shaNew = 'b'.repeat(40);
    const shaOld = 'a'.repeat(40);
    const out = [
      // 新提交（git log 先出）：单父、带 trailer、两个文件
      `\x1e${shaNew}\x1fphase(two): impl\x1f${'p'.repeat(40)}\x1fTested-By: aaaa111\n\n\nsrc/b.ts\ntest/b.test.ts\n`,
      // 旧提交：双父（merge）、无 trailer、一个文件
      `\x1e${shaOld}\x1fMerge branch x\x1f${'q'.repeat(40)} ${'r'.repeat(40)}\x1f\n\ntest/a.test.ts\n`,
    ].join('');

    const commits = parseWuGitLog(out);
    expect(commits).toHaveLength(2);
    // 反转为 base..HEAD 升序：旧提交在前
    expect(commits[0]).toEqual({
      sha: shaOld, subject: 'Merge branch x', body: '', files: ['test/a.test.ts'], isMerge: true,
    });
    expect(commits[1]).toEqual({
      sha: shaNew, subject: 'phase(two): impl', body: 'Tested-By: aaaa111',
      files: ['src/b.ts', 'test/b.test.ts'], isMerge: false,
    });
  });

  it('空输出（base..HEAD 零提交）→ 空数组', () => {
    expect(parseWuGitLog('')).toEqual([]);
  });
});

describe('completion-gates: T7-E2 loadCompletionCheckersConfig（yml 现读现解）', () => {
  it('文件缺失 / 缺 completion_checkers 段 / 坏 yml → {}（默认全开）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cfg-'));
    try {
      expect(loadCompletionCheckersConfig(dir)).toEqual({});

      fs.mkdirSync(path.join(dir, '.harness'));
      fs.writeFileSync(path.join(dir, '.harness', 'custom-constraints.yml'), 'custom_constraints: {}\n');
      expect(loadCompletionCheckersConfig(dir)).toEqual({});

      fs.writeFileSync(path.join(dir, '.harness', 'custom-constraints.yml'), ':\n  - [broken');
      expect(loadCompletionCheckersConfig(dir)).toEqual({});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('completion_checkers 段在场 → 原样取出（开关/glob/contracts 透传 harness）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cfg-'));
    try {
      fs.mkdirSync(path.join(dir, '.harness'));
      fs.writeFileSync(path.join(dir, '.harness', 'custom-constraints.yml'), [
        'completion_checkers:',
        '  checkers:',
        '    phaseFormat: false',
        '  testGlobs: ["**/*.spec.ts"]',
        '  contracts: ["review"]',
        '',
      ].join('\n'));
      expect(loadCompletionCheckersConfig(dir)).toEqual({
        checkers: { phaseFormat: false },
        testGlobs: ['**/*.spec.ts'],
        contracts: ['review'],
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
