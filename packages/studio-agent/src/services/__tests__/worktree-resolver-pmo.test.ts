/**
 * PMO-b（决策 3）：ensureBranchExists / ensurePmoIntegrationWorktree 测试
 *
 * AC:
 *   - 分支已存在（rev-parse 成功）→ 零写操作
 *   - 分支不存在 → git branch <branch> <baseBranch>
 *   - 集成交合已存在（.git）→ 复用，不重复 worktree add
 *   - 集成交合不存在 → 先确保分支，再 git worktree add <path> <branch>（非 -b，检出现有分支）
 *
 * Strategy: mock fs.existsSync/execSh（同 worktree-resolver-wu.test.ts 风格）。
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockExistsSync, mockExecSh } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockExecSh: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: mockExistsSync };
});

vi.mock('@dommaker/studio-shared/node', () => ({ execSh: mockExecSh }));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    FileStore: class { readJson = vi.fn(); },
  };
});

import { ensureBranchExists, ensurePmoIntegrationWorktree } from '../worktree-resolver.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockExecSh.mockResolvedValue({ stdout: '', stderr: '' });
});

describe('ensureBranchExists（PMO-b 决策 3）', () => {
  test('分支已存在 → 零写操作', async () => {
    await ensureBranchExists({ repoDir: '/repo', branch: 'PMO-11', baseBranch: 'master' });

    expect(mockExecSh).toHaveBeenCalledTimes(1);
    expect(mockExecSh.mock.calls[0][0]).toContain('rev-parse --verify');
  });

  test('分支不存在 → 从 baseBranch 创建', async () => {
    mockExecSh
      .mockRejectedValueOnce(new Error('unknown revision')) // rev-parse 失败
      .mockResolvedValue({ stdout: '', stderr: '' });

    await ensureBranchExists({ repoDir: '/repo', branch: 'PMO-11', baseBranch: 'master' });

    expect(mockExecSh).toHaveBeenCalledTimes(2);
    expect(mockExecSh.mock.calls[1][0]).toBe('git branch "PMO-11" "master"');
  });
});

describe('ensurePmoIntegrationWorktree（PMO-b 决策 3：单一合并点）', () => {
  const opts = {
    repoDir: '/repo',
    worktreesDir: '/worktrees',
    projectId: 'proj-1',
    branch: 'PMO-11',
    baseBranch: 'master',
  };

  test('分支不存在 + 交合不存在 → 建支 + worktree add（检出非 -b）', async () => {
    mockExistsSync.mockReturnValue(false);
    mockExecSh
      .mockRejectedValueOnce(new Error('unknown revision')) // rev-parse 失败 → 建支
      .mockResolvedValue({ stdout: '', stderr: '' });

    const r = await ensurePmoIntegrationWorktree(opts);

    expect(r.worktreePath).toBe('/worktrees/pmo-proj-1');
    const cmds = mockExecSh.mock.calls.map(c => c[0] as string);
    expect(cmds.some(c => c === 'git branch "PMO-11" "master"')).toBe(true);
    expect(cmds.some(c => c === 'git worktree add "/worktrees/pmo-proj-1" "PMO-11"')).toBe(true);
  });

  test('交合已存在（.git）→ 复用，不 worktree add；分支已存在 → 不建支', async () => {
    mockExistsSync.mockReturnValue(true); // .git 存在
    // rev-parse 成功（默认 mockResolvedValue）→ 分支存在

    const r = await ensurePmoIntegrationWorktree(opts);

    expect(r.worktreePath).toBe('/worktrees/pmo-proj-1');
    const cmds = mockExecSh.mock.calls.map(c => c[0] as string);
    expect(cmds.every(c => !c.includes('worktree add'))).toBe(true);
    expect(cmds.every(c => !c.startsWith('git branch '))).toBe(true);
  });
});
