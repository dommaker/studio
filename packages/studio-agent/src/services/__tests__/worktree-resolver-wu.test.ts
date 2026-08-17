/**
 * Behavioral tests for ensureWuWorktree() — B3b-i 每 WU 专属 worktree
 *
 * AC:
 *   - 首次创建 <worktreesDir>/wu-<wuId> + 分支 task/<wuId>（显式 branchName 传给 createWorktree）
 *   - 目录已存在（含 .git）→ 复用，不重建（零 git 调用）
 *   - 创建失败 → 清理半成品（worktree remove + rm + branch -D）后抛错，不静默退回
 *   - baseBranch：opts 显式值优先，缺省探测默认分支（无 git 环境回落 master）
 *   - branchPrefix（#157 T6）：缺省 task/；analysis 原型单传 prototype → 分支 prototype/<wuId>（创建与复用同口径）
 *
 * Strategy: mock fs/fs.promises/execSh（同 worktree-resolver.test.ts 风格），真实代码跑逻辑。
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockExistsSync, mockExecSh, mockRm } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockExecSh: vi.fn(),
  mockRm: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: mockExistsSync,
  };
});

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    rm: mockRm,
  };
});

vi.mock('@dommaker/studio-shared/node', () => ({
  execSh: mockExecSh,
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    FileStore: class {
      readJson = vi.fn();
    },
  };
});

import { ensureWuWorktree } from '../worktree-resolver.js';

const baseOpts = {
  wuId: 'wu-1',
  repoDir: '/repo',
  worktreesDir: '/worktrees',
  baseBranch: 'develop',
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default: repoDir 是 git 仓库（.git 存在），worktree 目录不存在
  mockExistsSync.mockImplementation((p: string) => p === '/repo/.git');
  mockExecSh.mockResolvedValue({ stdout: '', stderr: '' });
});

describe('ensureWuWorktree()', () => {
  test('creates <worktreesDir>/wu-<wuId> with branch task/<wuId> from baseBranch', async () => {
    const info = await ensureWuWorktree(baseOpts);

    expect(info).toEqual({
      worktreePath: '/worktrees/wu-wu-1',
      branch: 'task/wu-1',
      baseBranch: 'develop',
      baseRepo: '/repo',
    });
    expect(mockExecSh).toHaveBeenCalledWith(
      'git worktree add -b "task/wu-1" "/worktrees/wu-wu-1" "develop"',
      expect.objectContaining({ cwd: '/repo' }),
    );
  });

  test('branchPrefix=prototype（#157 T6 原型单）：分支 prototype/<wuId>', async () => {
    const info = await ensureWuWorktree({ ...baseOpts, branchPrefix: 'prototype' });

    expect(info.branch).toBe('prototype/wu-1');
    expect(mockExecSh).toHaveBeenCalledWith(
      'git worktree add -b "prototype/wu-1" "/worktrees/wu-wu-1" "develop"',
      expect.objectContaining({ cwd: '/repo' }),
    );
  });

  test('branchPrefix=prototype 复用路径同样返回 prototype/<wuId>（零 git 调用）', async () => {
    mockExistsSync.mockImplementation((p: string) => p === '/repo/.git' || p === '/worktrees/wu-wu-1/.git');

    const info = await ensureWuWorktree({ ...baseOpts, branchPrefix: 'prototype' });

    expect(info.branch).toBe('prototype/wu-1');
    expect(mockExecSh).not.toHaveBeenCalled();
  });

  test('reuses existing worktree dir (has .git) — zero git mutations, keeps metadata baseBranch', async () => {
    mockExistsSync.mockImplementation((p: string) => p === '/repo/.git' || p === '/worktrees/wu-wu-1/.git');

    const info = await ensureWuWorktree(baseOpts);

    expect(info.worktreePath).toBe('/worktrees/wu-wu-1');
    expect(info.branch).toBe('task/wu-1');
    expect(info.baseBranch).toBe('develop');
    expect(mockExecSh).not.toHaveBeenCalled();
  });

  test('reuse without recorded baseBranch probes default branch (falls back to master off-git)', async () => {
    mockExistsSync.mockImplementation((p: string) => p === '/repo/.git' || p === '/worktrees/wu-wu-1/.git');
    const { baseBranch, ...rest } = baseOpts;

    const info = await ensureWuWorktree(rest);

    // /repo 不是真实 git 仓库 → getDefaultBranch 探测链落空 → master
    expect(info.baseBranch).toBe('master');
    expect(mockExecSh).not.toHaveBeenCalled();
  });

  test('creation failure → cleans up half-baked artifacts then rethrows (no silent fallback)', async () => {
    mockExecSh.mockRejectedValue(new Error('fatal: invalid reference'));

    await expect(ensureWuWorktree(baseOpts)).rejects.toThrow('fatal: invalid reference');

    // 兜底清理：worktree 注册项 + 目录 + 分支
    expect(mockExecSh).toHaveBeenCalledWith(
      expect.stringContaining('git worktree remove --force "/worktrees/wu-wu-1"'),
      expect.objectContaining({ cwd: '/repo' }),
    );
    expect(mockRm).toHaveBeenCalledWith('/worktrees/wu-wu-1', { recursive: true, force: true });
    expect(mockExecSh).toHaveBeenCalledWith(
      expect.stringContaining('git branch -D "task/wu-1"'),
      expect.objectContaining({ cwd: '/repo' }),
    );
  });

  test('cleanup failures never mask the original creation error', async () => {
    // 所有 execSh（含清理）都失败 —— 抛出的仍是创建错误
    mockExecSh.mockRejectedValue(new Error('git totally broken'));
    mockRm.mockRejectedValue(new Error('rm broken'));

    await expect(ensureWuWorktree(baseOpts)).rejects.toThrow('git totally broken');
  });

  test('throws when repoDir is not a git repository (createWorktree validation)', async () => {
    mockExistsSync.mockReturnValue(false);

    await expect(ensureWuWorktree(baseOpts)).rejects.toThrow('repoDir is not a git repository: /repo');
  });
});
