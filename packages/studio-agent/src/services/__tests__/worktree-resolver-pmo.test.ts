/**
 * PMO-b（决策 3）：ensureBranchExists / ensurePmoIntegrationWorktree 测试
 *
 * AC:
 *   - 分支已存在（rev-parse 成功）→ 零写操作
 *   - 分支不存在 → git branch <branch> <baseBranch>
 *   - 集成交合已存在（.git）→ 复用，不重复 worktree add
 *   - 集成交合不存在 → 先确保分支，再 git worktree add <path> <branch>（非 -b，检出现有分支）
 *
 * Strategy: mock fs.existsSync/child_process，断言 execFile 参数数组与危险输入零子进程。
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockExistsSync, mockExecSh, mockExecFile, mockExecFileSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockExecSh: vi.fn(),
  mockExecFile: vi.fn(),
  mockExecFileSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: mockExecFile,
  execFileSync: mockExecFileSync,
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: mockExistsSync };
});

vi.mock('@dommaker/studio-shared/node', () => ({ execSh: mockExecSh, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return {
    ...actual,
    FileStore: class { readJson = vi.fn(); },
  };
});

import { ensureBranchExists, ensurePmoIntegrationWorktree } from '../worktree-resolver.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockExecSh.mockResolvedValue({ stdout: '', stderr: '' });
  mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    if (args.includes('--git-common-dir')) return cb(null, '/repo/.git\n', '');
    if (args.includes('--abbrev-ref')) return cb(null, 'PMO-11\n', '');
    return cb(null, '', '');
  });
});

describe('ensureBranchExists（PMO-b 决策 3）', () => {
  test('分支已存在 → check-ref-format + rev-parse 均走参数数组，零写操作', async () => {
    await ensureBranchExists({ repoDir: '/repo', branch: 'PMO-11', baseBranch: 'master' });

    expect(mockExecFile).toHaveBeenCalledWith('git', ['check-ref-format', '--branch', 'PMO-11'], expect.objectContaining({ cwd: '/repo' }), expect.any(Function));
    expect(mockExecFile).toHaveBeenCalledWith('git', ['rev-parse', '--verify', '--end-of-options', 'refs/heads/PMO-11'], expect.objectContaining({ cwd: '/repo' }), expect.any(Function));
    expect(mockExecFile).toHaveBeenCalledTimes(3);
    expect(mockExecSh).not.toHaveBeenCalled();
  });

  test('分支不存在 → 从 baseBranch 创建', async () => {
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      cb(args[0] === 'rev-parse' ? new Error('unknown revision') : null, '', '');
    });

    await ensureBranchExists({ repoDir: '/repo', branch: 'PMO-11', baseBranch: 'master' });

    expect(mockExecFile).toHaveBeenCalledWith('git', ['branch', '--', 'PMO-11', 'master'], expect.objectContaining({ cwd: '/repo' }), expect.any(Function));
    expect(mockExecFile).toHaveBeenCalledTimes(4);
    expect(mockExecSh).not.toHaveBeenCalled();
  });

  test.each([
    Object.assign(new Error('git timed out'), { killed: true, stderr: 'operation timed out' }),
    Object.assign(new Error('git failed'), { stderr: 'fatal: not a git repository' }),
    Object.assign(new Error('permission denied'), { code: 'EACCES', stderr: 'permission denied' }),
  ])('rev-parse 基础设施错误原样抛错，不误建分支', async error => {
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      cb(args[0] === 'rev-parse' ? error : null, '', '');
    });

    await expect(ensureBranchExists({ repoDir: '/repo', branch: 'PMO-11', baseBranch: 'master' })).rejects.toBe(error);
    const args = mockExecFile.mock.calls.map(call => call[1] as string[]);
    expect(args.some(argv => argv[0] === 'branch')).toBe(false);
  });

  test.each(['feature";id', 'feature$(id)', 'feature`id`', 'feature;id', 'feature\nid', '--upload-pack=id'])(
    '危险分支 %s 在零子进程副作用下被拒绝',
    async branch => {
      await expect(ensureBranchExists({ repoDir: '/repo', branch, baseBranch: 'master' })).rejects.toThrow('Invalid git branch');
      expect(mockExecSh).not.toHaveBeenCalled();
      expect(mockExecFile).not.toHaveBeenCalled();
      expect(mockExecFileSync).not.toHaveBeenCalled();
    },
  );
});

describe('ensurePmoIntegrationWorktree（#701：仓库/腿隔离的合并点）', () => {
  const opts = {
    repoDir: '/repo',
    worktreesDir: '/worktrees',
    projectId: 'proj-1',
    branch: 'PMO-11',
    baseBranch: 'master',
  };

  test('分支不存在 + 交合不存在 → 建支 + worktree add（检出非 -b）', async () => {
    mockExistsSync.mockReturnValue(false);
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      if (args.includes('--git-common-dir')) return cb(null, '/repo/.git\n', '');
      cb(args.includes('--verify') ? new Error('unknown revision') : null, '', '');
    });

    const r = await ensurePmoIntegrationWorktree(opts);

    expect(r.worktreePath).toMatch(/^\/worktrees\/pmo-proj-1-[a-f0-9]+-[a-f0-9]+$/);
    expect(mockExecFile).toHaveBeenCalledWith('git', ['branch', '--', 'PMO-11', 'master'], expect.any(Object), expect.any(Function));
    expect(mockExecFile).toHaveBeenCalledWith('git', ['worktree', 'add', '--', r.worktreePath, 'PMO-11'], expect.any(Object), expect.any(Function));
    expect(mockExecSh).not.toHaveBeenCalled();
  });

  test('交合已存在且 repo/branch 一致 → 复用，不 worktree add、不建支', async () => {
    mockExistsSync.mockReturnValue(true);

    const r = await ensurePmoIntegrationWorktree(opts);

    expect(r.worktreePath).toMatch(/^\/worktrees\/pmo-proj-1-[a-f0-9]+-[a-f0-9]+$/);
    const args = mockExecFile.mock.calls.map(c => c[1] as string[]);
    expect(args.every(a => a[0] !== 'worktree' && a[0] !== 'branch')).toBe(true);
    expect(args.some(a => a.includes('--git-common-dir') && a.includes('--abbrev-ref') === false)).toBe(true);
    expect(args.some(a => a.includes('--abbrev-ref') && a.includes('HEAD'))).toBe(true);
    expect(mockExecSh).not.toHaveBeenCalled();
  });

  test('#701 同 project 不同 repo/branch → 不同交合路径', async () => {
    mockExistsSync.mockReturnValue(false);
    mockExecFile.mockImplementation((_cmd: string, args: string[], opts: { cwd: string }, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      if (args.includes('--git-common-dir')) return cb(null, `${opts.cwd}/.git\n`, '');
      return cb(null, '', '');
    });

    const repoA = await ensurePmoIntegrationWorktree(opts);
    const repoB = await ensurePmoIntegrationWorktree({ ...opts, repoDir: '/repo-b' });
    const otherLeg = await ensurePmoIntegrationWorktree({ ...opts, branch: 'PMO-11-b' });

    expect(repoA.worktreePath).not.toBe(repoB.worktreePath);
    expect(repoA.worktreePath).not.toBe(otherLeg.worktreePath);
    expect(repoB.worktreePath).not.toBe(otherLeg.worktreePath);
  });

  test('#701 已存在交合 repo 或 checkout branch 不符 → 拒绝复用', async () => {
    mockExistsSync.mockReturnValue(true);
    mockExecFile.mockImplementation((_cmd: string, args: string[], opts: { cwd: string }, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      if (args.includes('--git-common-dir')) {
        return cb(null, opts.cwd === '/repo' ? '/repo/.git\n' : '/other/.git\n', '');
      }
      if (args.includes('--abbrev-ref')) return cb(null, 'PMO-other\n', '');
      return cb(null, '', '');
    });

    await expect(ensurePmoIntegrationWorktree(opts)).rejects.toThrow('身份不匹配');
    const args = mockExecFile.mock.calls.map(c => c[1] as string[]);
    expect(args.some(a => a[0] === 'worktree' || a.includes('merge'))).toBe(false);
  });
});
