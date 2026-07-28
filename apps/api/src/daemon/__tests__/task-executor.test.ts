/**
 * Task Executor tests — P5-03 agent execution lifecycle
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';

vi.mock('@dommaker/studio-shared', async (importOriginal) => ({
  // Spread real module: FileStore must exist (task-executor.ts constructs
  // `new FileStore()` at module scope for JSONL event writes).
  ...(await importOriginal<typeof import('@dommaker/studio-shared')>()),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  parseStreamLine: vi.fn((line: string) => {
    try { return JSON.parse(line); } catch { return null; }
  }),
  extractFilePath: vi.fn((toolName: string, input: unknown) => {
    if (!input || typeof input !== 'object') return null;
    const inp = input as Record<string, unknown>;
    if (toolName === 'Write' || toolName === 'Edit') {
      return (inp.file_path as string) || (inp.path as string) || null;
    }
    return null;
  }),
}));

vi.mock('../cli-adapter.js', () => ({
  buildSpawnArgs: vi.fn((_provider: string, params: any) => ({
    command: 'echo',
    args: ['--print', '--output-format', 'json'],
    env: {},
    promptViaStdin: false,
  })),
}));

const { fetchMock, mockChild, spawnMock } = vi.hoisted(() => {
  const EventEmitter = require('events').EventEmitter;
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.pid = 12345;

  const spawn = vi.fn(() => child);
  return { fetchMock: vi.fn(), mockChild: child, spawnMock: spawn };
});

vi.stubGlobal('fetch', fetchMock);

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: spawnMock };
});

import { TaskExecutor, type TaskExecutorConfig } from '../task-executor.js';
import type { ClaimedTask } from '../claim-loop.js';
import type { DetectedRuntime } from '../cli-scanner.js';

function makeConfig(overrides?: Partial<TaskExecutorConfig>): TaskExecutorConfig {
  return {
    serverUrl: 'http://localhost:3000',
    token: 'st_mach_test',
    workspaceId: 'ws-1',
    workspaceRoot: '/tmp/test-ws',
    runtimes: [{ provider: 'claude', path: '/usr/bin/claude', version: '1.0.0' }],
    cancelPollMs: 100,
    timeoutMs: 10_000,
    ...overrides,
  };
}

function makeTask(overrides?: Partial<ClaimedTask>): ClaimedTask {
  return {
    id: 'task-1',
    workspaceId: 'ws-1',
    runtimeId: 'claude',
    path: '/test',
    prompt: 'do something',
    agent: 'executor',
    sessionId: null,
    status: 'running',
    createdAt: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

describe('TaskExecutor', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-executor-test-'));
    fetchMock.mockReset();
    spawnMock.mockClear();
    mockChild.kill.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reports fail when runtime not found', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });

    const executor = new TaskExecutor(makeConfig({ runtimes: [] }));
    await executor.execute(makeTask());

    // Should call /fail
    const failCall = fetchMock.mock.calls.find((c: any[]) => String(c[0]).includes('/fail'));
    expect(failCall).toBeDefined();
    const body = JSON.parse(failCall![1].body);
    expect(body.error).toContain('Runtime not found');
  });

  it('spawns agent process with correct args', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });

    // Make child exit immediately
    process.nextTick(() => mockChild.emit('exit', 0));

    const executor = new TaskExecutor(makeConfig());
    await executor.execute(makeTask());

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.mock.calls[0];
    expect(cmd).toBe('echo');
    expect(opts.stdio).toEqual(['pipe', 'pipe', 'pipe']);
  });

  it('reports complete on exit code 0', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });

    process.nextTick(() => {
      mockChild.stdout.emit('data', Buffer.from('{"type":"result","result":"done"}\n'));
      mockChild.emit('exit', 0);
    });

    const executor = new TaskExecutor(makeConfig());
    await executor.execute(makeTask());

    const completeCall = fetchMock.mock.calls.find((c: any[]) => String(c[0]).includes('/complete'));
    expect(completeCall).toBeDefined();
  });

  it('reports fail on non-zero exit code', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });

    process.nextTick(() => {
      mockChild.stderr.emit('data', Buffer.from('something went wrong'));
      mockChild.emit('exit', 1);
    });

    const executor = new TaskExecutor(makeConfig());
    await executor.execute(makeTask());

    const failCall = fetchMock.mock.calls.find((c: any[]) => String(c[0]).includes('/fail'));
    expect(failCall).toBeDefined();
  });

  it('flushes output events in batches', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });

    process.nextTick(() => {
      // Send 10 lines to trigger batch flush
      for (let i = 0; i < 10; i++) {
        mockChild.stdout.emit('data', Buffer.from(`{"type":"result","result":"line ${i}"}\n`));
      }
      mockChild.emit('exit', 0);
    });

    const executor = new TaskExecutor(makeConfig());
    await executor.execute(makeTask());

    const messagesCall = fetchMock.mock.calls.find((c: any[]) => String(c[0]).includes('/messages'));
    expect(messagesCall).toBeDefined();
    const body = JSON.parse(messagesCall![1].body);
    expect(body.messages.length).toBeGreaterThan(0);
  });

  it('reports session pinning when sessionId present', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });

    process.nextTick(() => mockChild.emit('exit', 0));

    const executor = new TaskExecutor(makeConfig());
    await executor.execute(makeTask({ sessionId: 'sess-123' }));

    const sessionCall = fetchMock.mock.calls.find((c: any[]) => String(c[0]).includes('/session'));
    expect(sessionCall).toBeDefined();
  });

  it('skips session pinning when sessionId is null', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });

    process.nextTick(() => mockChild.emit('exit', 0));

    const executor = new TaskExecutor(makeConfig());
    await executor.execute(makeTask({ sessionId: null }));

    const sessionCall = fetchMock.mock.calls.find((c: any[]) => String(c[0]).includes('/session'));
    expect(sessionCall).toBeUndefined();
  });

  it('kills process on cancel signal', async () => {
    // First fetch = /status returns cancelled
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/status')) {
        return { ok: true, json: async () => ({ status: 'cancelled' }) };
      }
      return { ok: true, json: async () => ({}) };
    });

    // Keep child alive until cancel check fires
    const childResolve = vi.fn();
    mockChild.once('exit', () => childResolve());

    const executor = new TaskExecutor(makeConfig({ cancelPollMs: 50 }));
    const execPromise = executor.execute(makeTask());

    // Advance time to trigger cancel poll
    await vi.advanceTimersByTimeAsync(100);

    expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');

    // Make child exit
    mockChild.emit('exit', 0);
    await execPromise;
  });

  it('kill() returns false for unknown taskId', () => {
    const executor = new TaskExecutor(makeConfig());
    expect(executor.kill('nonexistent')).toBe(false);
  });
});
