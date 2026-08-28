/**
 * exec-async — monitor 轮内异步子进程包装（#374）
 */
import { describe, it, expect, vi } from 'vitest';

const { mockExec, mockExecFile } = vi.hoisted(() => ({
  mockExec: vi.fn(),
  mockExecFile: vi.fn(),
}));

vi.mock('child_process', () => ({ exec: mockExec, execFile: mockExecFile }));

import { execAsync, execFileAsync } from '../exec-async.js';

describe('exec-async (#374)', () => {
  it('execAsync：成功 resolve stdout，opts 透传', async () => {
    mockExec.mockImplementation((_cmd: string, opts: unknown, cb: (err: Error | null, out: string) => void) => cb(null, 'ok'));
    await expect(execAsync('echo hi', { cwd: '/tmp', timeout: 5000 })).resolves.toBe('ok');
    expect(mockExec).toHaveBeenCalledWith('echo hi', { cwd: '/tmp', timeout: 5000 }, expect.any(Function));
  });

  it('execAsync：非零退出/超时 reject', async () => {
    mockExec.mockImplementation((_cmd: string, _opts: unknown, cb: (err: Error | null, out: string) => void) => cb(new Error('Command failed'), ''));
    await expect(execAsync('false')).rejects.toThrow('Command failed');
  });

  it('execFileAsync：成功 resolve stdout，args+opts 透传（不经 shell 由 execFile 保证）', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, out: string) => void) => cb(null, 'a\nb\n'));
    await expect(execFileAsync('git', ['log', '--oneline'], { cwd: '/repo', timeout: 5000 })).resolves.toBe('a\nb\n');
    expect(mockExecFile).toHaveBeenCalledWith('git', ['log', '--oneline'], { cwd: '/repo', timeout: 5000 }, expect.any(Function));
  });

  it('execFileAsync：git 失败 reject（走调用方 best-effort catch）', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, out: string) => void) => cb(new Error('git fail'), ''));
    await expect(execFileAsync('git', ['diff'])).rejects.toThrow('git fail');
  });
});
