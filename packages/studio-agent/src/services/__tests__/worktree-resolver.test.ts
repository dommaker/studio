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

const { mockFindFirst, mockExistsSync, mockExecSh } = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockExistsSync: vi.fn(),
  mockExecSh: vi.fn(),
}));

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: { workspace: { findFirst: mockFindFirst } },
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: mockExistsSync };
});

vi.mock('@dommaker/studio-shared/node', () => ({
  execSh: mockExecSh,
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return { ...actual, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
});

import { resolveWorkspace } from '../worktree-resolver.js';

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
  mockExistsSync.mockReturnValue(false);
  mockFindFirst.mockResolvedValue(null);
  mockExecSh.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
});

describe('resolveWorkspace()', () => {
  test('priority 1: returns task.parameters.workspaceRoot when path exists', async () => {
    const task = makeTask({ workspaceRoot: '/custom/workspace' });
    mockExistsSync.mockImplementation((p: string) => p === '/custom/workspace');

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
    mockExistsSync.mockImplementation((p: string) => p === '/vps/root');

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
    mockExistsSync.mockReturnValue(false);

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

  test('priority 3: uses default baseBranch "main" when not specified', async () => {
    const task = makeTask();

    await resolveWorkspace({ task, ...baseOpts });

    expect(mockExecSh).toHaveBeenCalledWith(
      expect.stringContaining('"main"'),
      expect.objectContaining({ cwd: '/repo' }),
    );
  });

  test('priority 3: returns worktree path from config.worktreesDir', async () => {
    const task = makeTask();

    const result = await resolveWorkspace({ task, ...baseOpts });

    expect(result).toBe('/worktrees/exec-1');
  });
});
