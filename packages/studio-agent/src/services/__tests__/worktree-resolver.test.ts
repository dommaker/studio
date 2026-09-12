/**
 * Behavioral tests for resolveWorkspace()
 *
 * 执行目录解析（#481，2026-09-11 重排，本机 workspace 记录退出执行面）：
 *   1. task.parameters.workspaceRoot —— 上游归属信号（@文件引用 / PMO 项目 gitRepo /
 *      频道默认工程）解析出的真实项目目录
 *   2. hasWorktree=true → createWorktree()（代码类任务要隔离工作树，绝不退回共享目录）
 *   3. 无归属 → 显式配置的共享工作目录（REPO_DIR，执行时现场读，单一来源）；
 *      未配置/不存在 → 隔离 scratch（绝不猜一个真实仓）
 *
 * Strategy: mock external deps (fs, execSh, studio-dir), let real code run.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockExistsSync, mockExecSh, mockReadFileSync, mockMkdirSync, mockWriteFile, mockStudioPath } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockExecSh: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockWriteFile: vi.fn().mockResolvedValue(undefined),
  mockStudioPath: vi.fn((...parts: string[]) => ['/.studio', ...parts].join('/')),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    mkdirSync: mockMkdirSync,
  };
});

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    writeFile: mockWriteFile,
    rm: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('@dommaker/studio-shared/node', () => ({
  execSh: mockExecSh,
}));

vi.mock('@dommaker/studio-shared/studio-dir', () => ({
  studioPath: mockStudioPath,
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

import { resolveWorkspace, ensureDeps } from '../worktree-resolver.js';

const baseOpts = {
  worktreesDir: '/worktrees',
  repoDir: '/repo',
};

function makeTask(overrides?: Record<string, unknown>) {
  return {
    id: 'task-1',
    executionId: 'exec-1',
    prompt: 'do something',
    parameters: { ...overrides },
  } as any;
}

let savedRepoDir: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  // Default: return true for .git checks (repoDir validation), false otherwise
  mockExistsSync.mockImplementation((p: string) => p.endsWith('/.git'));
  mockExecSh.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
  // 缺省无共享工作目录配置（REPO_DIR 未设）→ 无归属落 scratch
  savedRepoDir = process.env.REPO_DIR;
  delete process.env.REPO_DIR;
});

afterEach(() => {
  if (savedRepoDir === undefined) delete process.env.REPO_DIR;
  else process.env.REPO_DIR = savedRepoDir;
});

describe('resolveWorkspace()', () => {
  test('priority 1: returns task.parameters.workspaceRoot when path exists', async () => {
    const task = makeTask({ workspaceRoot: '/custom/workspace' });
    mockExistsSync.mockImplementation((p: string) => p === '/custom/workspace' || p.endsWith('/.git'));

    const result = await resolveWorkspace({ task, ...baseOpts });

    expect(result).toBe('/custom/workspace');
    expect(mockExecSh).not.toHaveBeenCalled();
  });

  test('priority 1 skipped: workspaceRoot set but path does not exist → 无归属落 scratch', async () => {
    const task = makeTask({ workspaceRoot: '/nonexistent' });

    const result = await resolveWorkspace({ task, ...baseOpts, scratchDir: '/scratch' });

    expect(result).toBe('/scratch/exec-1');
    expect(mockExecSh).not.toHaveBeenCalled();
  });

  test('priority 2: hasWorktree=true creates worktree（绝不退回共享目录/scratch）', async () => {
    const task = makeTask({ hasWorktree: true });
    // 共享工作目录已配置且存在 —— hasWorktree 仍优先
    process.env.REPO_DIR = '/shared';
    mockExistsSync.mockImplementation((p: string) => p === '/shared' || p.endsWith('/.git'));

    const result = await resolveWorkspace({ task, ...baseOpts });

    expect(result).toBe('/worktrees/exec-1');
    expect(mockExecSh).toHaveBeenCalledWith(
      expect.stringContaining('git worktree add'),
      expect.anything(),
    );
  });

  test('priority 2: hasWorktree=true with task repoDir and baseBranch', async () => {
    const task = makeTask({ hasWorktree: true, repoDir: '/custom/repo', baseBranch: 'develop' });

    const result = await resolveWorkspace({ task, ...baseOpts });

    expect(result).toBe('/worktrees/exec-1');
    expect(mockExecSh).toHaveBeenCalledWith(
      expect.stringContaining('git worktree add'),
      expect.objectContaining({
        cwd: '/custom/repo',
      }),
    );
  });

  test('priority 2: hasWorktree=true uses getDefaultBranch() when baseBranch not specified', async () => {
    const task = makeTask({ hasWorktree: true });

    await resolveWorkspace({ task, ...baseOpts });

    // getDefaultBranch is inlined — falls back to 'master' when repo doesn't exist
    expect(mockExecSh).toHaveBeenCalledWith(
      expect.stringContaining('git worktree add'),
      expect.objectContaining({ cwd: '/repo' }),
    );
  });

  test('priority 2: hasWorktree=true throws when repoDir is not a git repository', async () => {
    const task = makeTask({ hasWorktree: true, repoDir: '/not-a-repo' });
    // .git check returns false for /not-a-repo/.git
    mockExistsSync.mockReturnValue(false);

    await expect(resolveWorkspace({ task, ...baseOpts }))
      .rejects.toThrow('repoDir is not a git repository: /not-a-repo');
  });

  test('priority 3: 无归属 + REPO_DIR 已配置且存在 → 共享工作目录（只读类任务能读到代码）', async () => {
    const task = makeTask();
    process.env.REPO_DIR = '/shared/work';
    mockExistsSync.mockImplementation((p: string) => p === '/shared/work' || p.endsWith('/.git'));

    const result = await resolveWorkspace({ task, ...baseOpts });

    expect(result).toBe('/shared/work');
    // 不建 worktree、不建 scratch
    expect(mockExecSh).not.toHaveBeenCalled();
    expect(mockMkdirSync).not.toHaveBeenCalled();
  });

  test('priority 3: REPO_DIR 已配置但路径不存在 → 落隔离 scratch（不猜真实仓）', async () => {
    const task = makeTask();
    process.env.REPO_DIR = '/shared/gone';
    mockExistsSync.mockImplementation((p: string) => p.endsWith('/.git'));

    const result = await resolveWorkspace({ task, ...baseOpts, scratchDir: '/scratch' });

    expect(result).toBe('/scratch/exec-1');
    expect(mockMkdirSync).toHaveBeenCalledWith('/scratch/exec-1', { recursive: true });
    expect(mockExecSh).not.toHaveBeenCalled();
  });

  test('priority 3: REPO_DIR 未配置 → 隔离 scratch，不在 repoDir 建 worktree（#481 防回归锚点）', async () => {
    const task = makeTask();

    const result = await resolveWorkspace({ task, ...baseOpts, scratchDir: '/scratch' });

    // 旧行为（无归属兜底 createWorktree / 读本机 workspace 记录 root）已退役：
    // 执行目录绝不落在任何真实仓上
    expect(result).toBe('/scratch/exec-1');
    expect(mockMkdirSync).toHaveBeenCalledWith('/scratch/exec-1', { recursive: true });
    expect(mockExecSh).not.toHaveBeenCalled();
  });

  test('priority 3: scratchDir 缺省 = 数据区 studioPath(\'scratch\')', async () => {
    const task = makeTask();

    const result = await resolveWorkspace({ task, ...baseOpts });

    expect(mockStudioPath).toHaveBeenCalledWith('scratch');
    expect(result).toBe('/.studio/scratch/exec-1');
  });
});

describe('ensureDeps()', () => {
  beforeEach(() => {
    // Default: readFileSync returns a fixed buffer for lockfile hashing
    mockReadFileSync.mockReturnValue(Buffer.from('mock-lockfile-content'));
  });

  test('skips when node_modules/.modules.yaml already exists', async () => {
    mockExistsSync.mockImplementation((p: string) =>
      p.endsWith('/node_modules/.modules.yaml') || p.endsWith('/package.json'),
    );

    await ensureDeps('/worktree', '/repo');

    // Should not call execSh (no install, no cp)
    expect(mockExecSh).not.toHaveBeenCalled();
  });

  test('非项目检出（无 lockfile 且无 package.json）→ 直接返回，不拿 repoDir 的 lockfile 硬链依赖', async () => {
    // scratch 兜底目录：里面什么都没有；repoDir 有 lockfile
    mockExistsSync.mockImplementation((p: string) => p === '/repo/pnpm-lock.yaml');

    await ensureDeps('/scratch/exec-1', '/repo');

    expect(mockExecSh).not.toHaveBeenCalled();
  });

  test('cache HIT: cp -al from cache when lockfile hash matches', async () => {
    // node_modules/.modules.yaml does NOT exist (no deps installed)
    // pnpm-lock.yaml exists in worktree
    // Cache entry exists for the hash
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith('/node_modules/.modules.yaml')) return false;
      if (p.endsWith('/pnpm-lock.yaml')) return true;
      if (p.includes('.cache/studio-deps/') && p.endsWith('/node_modules')) return true;
      return false;
    });

    await ensureDeps('/worktree', '/repo');

    // Should call cp -al (hardlink copy from cache)
    expect(mockExecSh).toHaveBeenCalledWith(
      expect.stringContaining('cp -al'),
      expect.objectContaining({ cwd: '/worktree' }),
    );
    // Should NOT run pnpm install
    expect(mockExecSh).not.toHaveBeenCalledWith(
      expect.stringContaining('pnpm install'),
      expect.anything(),
    );
  });

  test('cache MISS: runs pnpm install --frozen-lockfile then caches result', async () => {
    // node_modules/.modules.yaml does NOT exist
    // pnpm-lock.yaml exists in worktree
    // Cache entry does NOT exist
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith('/node_modules/.modules.yaml')) return false;
      if (p.endsWith('/pnpm-lock.yaml')) return true;
      // Cache dir does not exist
      if (p.includes('.cache/studio-deps/')) return false;
      return false;
    });

    await ensureDeps('/worktree', '/repo');

    // Should run pnpm install --frozen-lockfile
    expect(mockExecSh).toHaveBeenCalledWith(
      'pnpm install --frozen-lockfile',
      expect.objectContaining({ cwd: '/worktree' }),
    );
    // Should cache result via cp -al
    expect(mockExecSh).toHaveBeenCalledWith(
      expect.stringContaining('cp -al'),
      expect.objectContaining({ cwd: '/worktree' }),
    );
  });

  test('detects npm (package-lock.json) and uses npm ci', async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith('/node_modules/.modules.yaml')) return false;
      if (p.endsWith('/pnpm-lock.yaml')) return false;
      if (p.endsWith('/package-lock.json')) return true;
      if (p.includes('.cache/studio-deps/')) return false;
      return false;
    });

    await ensureDeps('/worktree', '/repo');

    expect(mockExecSh).toHaveBeenCalledWith(
      'npm ci',
      expect.objectContaining({ cwd: '/worktree' }),
    );
  });

  test('falls back to npm install when no lockfile found (package.json present)', async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith('/node_modules/.modules.yaml')) return false;
      // package.json 存在（是项目检出），但没有任何 lockfile
      if (p.endsWith('/package.json')) return true;
      return false;
    });

    await ensureDeps('/worktree', '/repo');

    expect(mockExecSh).toHaveBeenCalledWith(
      expect.stringContaining('install'),
      expect.objectContaining({ cwd: '/worktree' }),
    );
  });

  test('hardlink copy failure falls back to pnpm install', async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith('/node_modules/.modules.yaml')) return false;
      if (p.endsWith('/pnpm-lock.yaml')) return true;
      if (p.includes('.cache/studio-deps/') && p.endsWith('/node_modules')) return true;
      return false;
    });
    // First call (cp -al) fails, second call (pnpm install) succeeds
    mockExecSh
      .mockRejectedValueOnce(new Error('Cross-device link'))
      .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

    await ensureDeps('/worktree', '/repo');

    // Should have attempted cp -al, then fallen back to pnpm install
    expect(mockExecSh).toHaveBeenCalledWith(
      'pnpm install --frozen-lockfile',
      expect.objectContaining({ cwd: '/worktree' }),
    );
  });

  test('install failure propagates error', async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith('/node_modules/.modules.yaml')) return false;
      if (p.endsWith('/pnpm-lock.yaml')) return true;
      if (p.includes('.cache/studio-deps/')) return false;
      return false;
    });
    mockExecSh.mockRejectedValue(new Error('pnpm install failed'));

    await expect(ensureDeps('/worktree', '/repo'))
      .rejects.toThrow('pnpm install failed');
  });
});
