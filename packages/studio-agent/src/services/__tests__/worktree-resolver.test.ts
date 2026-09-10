/**
 * Behavioral tests for resolveWorkspace()
 *
 * AC: executor 通过 Workspace 获取工作区（D3）
 *
 * Priority chain（2026-09-10 起）:
 *   1. task.parameters.workspaceRoot —— 上游归属信号解析出的真实项目目录（@文件/PMO/频道默认）
 *   2. hasWorktree=true → createWorktree()（代码类任务要隔离工作树）
 *   3. 都没有 → scratch 隔离目录（**不再抓任何真实仓**）
 *
 * 变更理由：第 3 级原先是「读本机 VPS workspace 记录的 root」，而那条记录的 root 来自
 * 最早启动的服务器进程的 REPO_DIR——生产上它指向开发工作副本，等于「没解析出归属的任务
 * 悄悄在别人的代码目录里跑」（证据形态：执行日志的 cwd 落在服务器自身的源码工作副本、甚至其上层目录）。
 * 现已判死的远程节点方向不该继续充当执行面的隐式兜底。
 *
 * Strategy: mock external deps (fs, execSh), let real code run.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockExistsSync, mockExecSh, mockReadFileSync, mockMkdirSync, mockWriteFile, mockResolveVpsWorkspace } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockExecSh: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockWriteFile: vi.fn().mockResolvedValue(undefined),
  mockResolveVpsWorkspace: vi.fn(),
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

vi.mock('@dommaker/studio-shared/node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared/node')>();
  return {
    ...actual,
    execSh: mockExecSh,
    resolveVpsWorkspace: mockResolveVpsWorkspace,
  };
});

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
  scratchDir: '/scratch',
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
  // 本机 VPS 记录"存在"也不该再影响执行目录（防回归锚点）
  mockResolveVpsWorkspace.mockResolvedValue({
    id: 'ws-1', name: 'VPS', workspaceRoot: '/vps/root', updatedAt: '2026-01-01T00:00:00Z',
  });
  mockExecSh.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
});

describe('resolveWorkspace()', () => {
  test('priority 1: returns task.parameters.workspaceRoot when path exists', async () => {
    const task = makeTask({ workspaceRoot: '/custom/workspace' });
    mockExistsSync.mockImplementation((p: string) => p === '/custom/workspace' || p.endsWith('/.git'));

    const result = await resolveWorkspace({ task, ...baseOpts });

    expect(result).toBe('/custom/workspace');
    expect(mockExecSh).not.toHaveBeenCalled();
  });

  test('priority 1 skipped: workspaceRoot set but path does not exist', async () => {
    const task = makeTask({ workspaceRoot: '/nonexistent' });

    await resolveWorkspace({ task, ...baseOpts });

    // 没有真实归属 → 走 scratch，不去建 worktree、不去查本机记录
    expect(mockMkdirSync).toHaveBeenCalled();
    expect(mockExecSh).not.toHaveBeenCalled();
  });

  test('无归属任务落到 scratch 隔离目录，不碰任何真实仓（远程节点隐式兜底已移除）', async () => {
    const task = makeTask();

    const result = await resolveWorkspace({ task, ...baseOpts });

    expect(result).toBe('/scratch/exec-1');
    expect(mockMkdirSync).toHaveBeenCalledWith('/scratch/exec-1', { recursive: true });
    expect(mockResolveVpsWorkspace).not.toHaveBeenCalled();
    expect(mockExecSh).not.toHaveBeenCalledWith(expect.stringContaining('git worktree add'), expect.anything());
  });

  test('hasWorktree=true 仍建隔离 worktree（代码类任务不受 scratch 影响）', async () => {
    const task = makeTask({ hasWorktree: true, repoDir: '/custom/repo', baseBranch: 'develop' });

    const result = await resolveWorkspace({ task, ...baseOpts });

    expect(result).toBe('/worktrees/exec-1');
    expect(mockExecSh).toHaveBeenCalledWith(
      expect.stringContaining('git worktree add'),
      expect.objectContaining({ cwd: '/custom/repo' }),
    );
    expect(mockResolveVpsWorkspace).not.toHaveBeenCalled();
  });

  test('priority 3: creates worktree with task repoDir and baseBranch', async () => {
    const task = makeTask({ hasWorktree: true, repoDir: '/custom/repo', baseBranch: 'develop' });

    const result = await resolveWorkspace({ task, ...baseOpts });

    expect(result).toBe('/worktrees/exec-1');
    expect(mockExecSh).toHaveBeenCalledWith(
      expect.stringContaining('git worktree add'),
      expect.objectContaining({ cwd: '/custom/repo' }),
    );
  });

  test('priority 3: uses getDefaultBranch() when baseBranch not specified', async () => {
    const task = makeTask({ hasWorktree: true });

    await resolveWorkspace({ task, ...baseOpts });

    expect(mockExecSh).toHaveBeenCalledWith(
      expect.stringContaining('git worktree add'),
      expect.objectContaining({ cwd: '/repo' }),
    );
  });

  test('priority 3: returns worktree path from config.worktreesDir', async () => {
    const task = makeTask({ hasWorktree: true });

    const result = await resolveWorkspace({ task, ...baseOpts });

    expect(result).toBe('/worktrees/exec-1');
  });

  test('priority 3 throws when repoDir is not a git repository', async () => {
    const task = makeTask({ hasWorktree: true, repoDir: '/not-a-repo' });
    mockExistsSync.mockReturnValue(false);

    await expect(resolveWorkspace({ task, ...baseOpts }))
      .rejects.toThrow('repoDir is not a git repository: /not-a-repo');
  });

  test('scratchDir 缺省时落到数据区，不写进任何仓', async () => {
    const task = makeTask();

    const { studioPath } = await import('@dommaker/studio-shared/studio-dir');
    const result = await resolveWorkspace({ task, worktreesDir: '/worktrees', repoDir: '/repo' });

    expect(result).toBe(studioPath('scratch', 'exec-1'));
  });
});

describe('ensureDeps()', () => {
  beforeEach(() => {
    // Default: readFileSync returns a fixed buffer for lockfile hashing
    mockReadFileSync.mockReturnValue(Buffer.from('mock-lockfile-content'));
  });

  test('隔离 scratch（无 package.json）直接跳过：不装依赖、不硬链', async () => {
    mockExistsSync.mockImplementation((p: string) => {
      // scratch 里什么都没有；repoDir 有 lockfile（旧行为会据此把 node_modules 硬链进 scratch）
      if (p === '/repo/pnpm-lock.yaml') return true;
      return false;
    });

    await ensureDeps('/scratch/exec-1', '/repo');

    expect(mockExecSh).not.toHaveBeenCalled();
  });

  test('skips when node_modules/.modules.yaml already exists', async () => {
    mockExistsSync.mockImplementation((p: string) =>
      p.endsWith('/node_modules/.modules.yaml') || p.endsWith('/package.json'),
    );

    await ensureDeps('/worktree', '/repo');

    // Should not call execSh (no install, no cp)
    expect(mockExecSh).not.toHaveBeenCalled();
  });

  test('cache HIT: cp -al from cache when lockfile hash matches', async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith('/node_modules/.modules.yaml')) return false;
      if (p.endsWith('/pnpm-lock.yaml')) return true;
      if (p.includes('.cache/studio-deps/') && p.endsWith('/node_modules')) return true;
      return false;
    });

    await ensureDeps('/worktree', '/repo');

    expect(mockExecSh).toHaveBeenCalledWith(
      expect.stringContaining('cp -al'),
      expect.objectContaining({ cwd: '/worktree' }),
    );
    expect(mockExecSh).not.toHaveBeenCalledWith(
      expect.stringContaining('pnpm install'),
      expect.anything(),
    );
  });

  test('cache MISS: runs pnpm install --frozen-lockfile then caches result', async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith('/node_modules/.modules.yaml')) return false;
      if (p.endsWith('/pnpm-lock.yaml')) return true;
      if (p.includes('.cache/studio-deps/')) return false;
      return false;
    });

    await ensureDeps('/worktree', '/repo');

    expect(mockExecSh).toHaveBeenCalledWith(
      'pnpm install --frozen-lockfile',
      expect.objectContaining({ cwd: '/worktree' }),
    );
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
      // 真实项目检出（有 package.json）但没有任何 lockfile
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
    mockExecSh
      .mockRejectedValueOnce(new Error('Cross-device link'))
      .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

    await ensureDeps('/worktree', '/repo');

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
