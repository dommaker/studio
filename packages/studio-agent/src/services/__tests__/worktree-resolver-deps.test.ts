/**
 * Behavioral tests for ensureDeps() lockfile fallback.
 *
 * AC:
 *   1. ensureDeps with incompatible lockfile (ERR_PNPM_LOCKFILE_BREAKING_CHANGE) → fallback to --force succeeds
 *   2. ensureDeps with other error → re-thrown
 *
 * Strategy: mock execSh, fs, let real ensureDeps run.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockExistsSync, mockExecSh, mockReadFileSync, mockMkdirSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockExecSh: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockMkdirSync: vi.fn(),
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
    mkdir: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('@dommaker/studio-shared/node', () => ({
  execSh: mockExecSh,
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return { ...actual, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
});

import { ensureDeps } from '../worktree-resolver.js';

function makeLockfileError(msg: string): Error {
  const err = new Error(`Command exited with code 1: ${msg}`) as Error & { stderr: string; stdout: string };
  err.stderr = msg;
  err.stdout = '';
  return err;
}

beforeEach(() => {
  vi.clearAllMocks();
  // node_modules/.modules.yaml doesn't exist (need to install)
  mockExistsSync.mockImplementation((p: string) => {
    if (p.endsWith('.modules.yaml')) return false;
    if (p.endsWith('pnpm-lock.yaml')) return true;
    if (p.endsWith('node_modules')) return false;
    return false;
  });
  mockReadFileSync.mockReturnValue(Buffer.from('lockfile-content'));
  mockExecSh.mockResolvedValue({ stdout: '', stderr: '' });
});

describe('ensureDeps lockfile fallback', () => {
  test('incompatible lockfile → fallback to pnpm install --force', async () => {
    // First call (--frozen-lockfile) fails with lockfile error
    mockExecSh.mockRejectedValueOnce(makeLockfileError('ERR_PNPM_LOCKFILE_BREAKING_CHANGE: lockfile v5'));
    // Second call (--force) succeeds
    mockExecSh.mockResolvedValueOnce({ stdout: '', stderr: '' });

    await ensureDeps('/worktree/exec-1', '/repo');

    const calls = mockExecSh.mock.calls;
    // First call: frozen-lockfile install
    expect(calls[0][0]).toContain('--frozen-lockfile');
    // Second call: --force fallback
    expect(calls[1][0]).toContain('--force');
  });

  test('other error → re-thrown', async () => {
    const networkError = makeLockfileError('ECONNREFUSED network down');
    mockExecSh.mockRejectedValueOnce(networkError);

    await expect(ensureDeps('/worktree/exec-2', '/repo')).rejects.toThrow(/ECONNREFUSED/);

    // Only one call — no fallback
    expect(mockExecSh).toHaveBeenCalledTimes(1);
  });
});
