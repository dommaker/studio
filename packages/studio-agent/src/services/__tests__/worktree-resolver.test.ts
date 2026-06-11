/**
 * Behavioral tests for resolveWorkspace()
 *
 * AC: executor 通过 Workspace 获取工作区（D3）
 *
 * Priority chain:
 *   1. task.parameters.workspaceRoot (direct path)
 *   2. VPS workspace DB query (prisma.workspace.findFirst)
 *   3. createWorktree() fallback (calls git worktree add via execSh)
 *
 * Strategy: mock external deps (prisma, fs, execSh), let real code run.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockFindFirst, mockExistsSync, mockExecSh, mockReadFileSync, mockMkdirSync } = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockExistsSync: vi.fn(),
  mockExecSh: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockMkdirSync: vi.fn(),
}));

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: { workspace: { findFirst: mockFindFirst } },
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

vi.mock('@dommaker/studio-shared/node', () => ({
  execSh: mockExecSh,
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return { ...actual, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
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

beforeEach(() => {
  vi.clearAllMocks();
  // Default: return true for .git checks (repoDir validation), false otherwise
  mockExistsSync.mockImplementation((p: string) => p.endsWith('/.git'));
  mockFindFirst.mockResolvedValue(null);
  mockExecSh.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
});

describe('resolveWorkspace()', () => {
  test('priority 1: returns task.parameters.workspaceRoot when path exists', async () => {
    const task = makeTask({ workspaceRoot: '/custom/workspace' });
    mockExistsSync.mockImplementation((p: string) => p === '/custom/workspace' || p.endsWith('/.git'));

    const result = await resolveWorkspace({ task, ...baseOpts });

    expect(result).toBe('/custom/workspace');
    expect(mockFindFirst).not.toHaveBeenCalled();
    expect(mockExecSh).not.toHaveBeenCalled();
  });

  test('priority 1 skipped: workspaceRoot set but path does not exist', async () => {
    const task = makeTask({ workspaceRoot: '/nonexistent' });
    mockFindFirst.mockResolvedValue(null);

    await resolveWorkspace({ task, ...baseOpts });

    // Falls through to priority 3 — createWorktree calls execSh
    expect(mockExecSh).toHaveBeenCalled();
  });

  test('priority 2: returns VPS workspaceRoot from DB when path exists', async () => {
    const task = makeTask();
    mockFindFirst.mockResolvedValue({
      id: 'ws-1',
      workspaceRoot: '/vps/root',
    });
    mockExistsSync.mockImplementation((p: string) => p === '/vps/root' || p.endsWith('/.git'));

    const result = await resolveWorkspace({ task, ...baseOpts });

    expect(result).toBe('/vps/root');
    expect(mockFindFirst).toHaveBeenCalledWith({
      where: { name: 'VPS', tokenId: null },
      orderBy: { updatedAt: 'desc' },
    });
    expect(mockExecSh).not.toHaveBeenCalled();
  });

  test('priority 2 skipped: DB returns workspace but path does not exist', async () => {
    const task = makeTask();
    mockFindFirst.mockResolvedValue({
      id: 'ws-1',
      workspaceRoot: '/stale/path',
    });
    mockExistsSync.mockImplementation((p: string) => p.endsWith('/.git'));

    await resolveWorkspace({ task, ...baseOpts });

    // Falls through to priority 3
    expect(mockExecSh).toHaveBeenCalled();
  });

  test('priority 2 skipped: DB query throws', async () => {
    const task = makeTask();
    mockFindFirst.mockRejectedValue(new Error('DB connection lost'));

    await resolveWorkspace({ task, ...baseOpts });

    expect(mockExecSh).toHaveBeenCalled();
  });

  test('priority 3: creates worktree with task repoDir and baseBranch', async () => {
    const task = makeTask({ repoDir: '/custom/repo', baseBranch: 'develop' });

    const result = await resolveWorkspace({ task, ...baseOpts });

    expect(result).toBe('/worktrees/exec-1');
    // createWorktree calls execSh with git worktree add
    expect(mockExecSh).toHaveBeenCalledWith(
      expect.stringContaining('git worktree add'),
      expect.objectContaining({
        cwd: '/custom/repo',
      }),
    );
  });

  test('priority 3: uses getDefaultBranch() when baseBranch not specified', async () => {
    const task = makeTask();

    await resolveWorkspace({ task, ...baseOpts });

    // getDefaultBranch is inlined — falls back to 'master' when repo doesn't exist
    expect(mockExecSh).toHaveBeenCalledWith(
      expect.stringContaining('git worktree add'),
      expect.objectContaining({ cwd: '/repo' }),
    );
  });

  test('priority 3: returns worktree path from config.worktreesDir', async () => {
    const task = makeTask();

    const result = await resolveWorkspace({ task, ...baseOpts });

    expect(result).toBe('/worktrees/exec-1');
  });

  test('hasWorktree=true skips priority 2 (VPS workspace) and creates worktree', async () => {
    const task = makeTask({ hasWorktree: true });
    // VPS workspace exists in DB — but should be skipped
    mockFindFirst.mockResolvedValue({
      id: 'ws-1',
      workspaceRoot: '/vps/root',
    });
    mockExistsSync.mockImplementation((p: string) => p === '/vps/root' || p.endsWith('/.git'));

    const result = await resolveWorkspace({ task, ...baseOpts });

    // Should NOT use VPS workspace
    expect(result).toBe('/worktrees/exec-1');
    expect(mockFindFirst).not.toHaveBeenCalled();
    // Should create worktree
    expect(mockExecSh).toHaveBeenCalledWith(
      expect.stringContaining('git worktree add'),
      expect.anything(),
    );
  });

  test('priority 3 throws when repoDir is not a git repository', async () => {
    const task = makeTask({ repoDir: '/not-a-repo' });
    // .git check returns false for /not-a-repo/.git
    mockExistsSync.mockReturnValue(false);

    await expect(resolveWorkspace({ task, ...baseOpts }))
      .rejects.toThrow('repoDir is not a git repository: /not-a-repo');
  });
});

describe('ensureDeps()', () => {
  beforeEach(() => {
    // Default: readFileSync returns a fixed buffer for lockfile hashing
    mockReadFileSync.mockReturnValue(Buffer.from('mock-lockfile-content'));
  });

  test('skips when node_modules/.modules.yaml already exists', async () => {
    mockExistsSync.mockImplementation((p: string) =>
      p.endsWith('/node_modules/.modules.yaml'),
    );

    await ensureDeps('/worktree', '/repo');

    // Should not call execSh (no install, no cp)
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

  test('falls back to npm install when no lockfile found', async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith('/node_modules/.modules.yaml')) return false;
      // No lockfile anywhere
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
