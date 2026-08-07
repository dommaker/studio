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
  type CompletionGuardDeps,
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
