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
import { setSegmentMetricsSink, type SegmentMetricEvent } from '@dommaker/studio-shared/read-metrics';

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

describe('exec-async exec 段计时（#411）', () => {
  let events: SegmentMetricEvent[];
  beforeEach(() => {
    events = [];
    setSegmentMetricsSink(e => events.push(e));
  });
  afterEach(() => {
    setSegmentMetricsSink(null);
  });

  it('sink 开启：execAsync 上报 exec 段事件，命令名取到首个 flag 前（上限 4 token），成功/失败都发', async () => {
    mockExec.mockImplementation((_cmd: string, _opts: unknown, cb: (err: Error | null, out: string) => void) => cb(null, ''));
    await execAsync('git worktree prune', { timeout: 5000 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'exec', name: 'git worktree prune' });
    expect(events[0].ms).toBeGreaterThanOrEqual(0);

    mockExec.mockImplementation((_cmd: string, _opts: unknown, cb: (err: Error | null, out: string) => void) => cb(new Error('x'), ''));
    await expect(execAsync('npx tsx src/cli/studio-cli.ts status --json 2>/dev/null')).rejects.toThrow('x');
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ kind: 'exec', name: 'npx tsx src/cli/studio-cli.ts status' });
  });

  it('sink 开启：execFileAsync 上报 exec 段事件（flag 前截断，args 不进段名）', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, out: string) => void) => cb(null, ''));
    await execFileAsync('git', ['log', '--oneline', '-n', '5']);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'exec', name: 'git log' });
  });

  it('sink 开启：易变 flag 参数不进段名——git log --since=<时间戳> 稳定归并为一组', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, out: string) => void) => cb(null, ''));
    await execFileAsync('git', ['log', '--since=2026-09-01T00:00:00.000Z', '--json']);
    await execFileAsync('git', ['log', '--since=2026-09-01T00:05:00.000Z', '--json']);
    expect(events).toHaveLength(2);
    expect(events[0].name).toBe('git log');
    expect(events[1].name).toBe('git log');
  });

  it('sink 关闭（默认）：行为与事件面零变化', async () => {
    setSegmentMetricsSink(null);
    mockExec.mockImplementation((_cmd: string, _opts: unknown, cb: (err: Error | null, out: string) => void) => cb(null, 'ok'));
    await expect(execAsync('git worktree prune')).resolves.toBe('ok');
    expect(events).toHaveLength(0);
  });
});
