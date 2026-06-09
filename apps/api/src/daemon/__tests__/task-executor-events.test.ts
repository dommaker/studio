/**
 * Task Executor — daemon-event-capture tests
 *
 * Verifies tool_use stdout blocks trigger StudioEvent writes (AC1.1/AC1.2/AC1.3).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  getModelForTier: vi.fn(() => 'claude-sonnet-4-20250514'),
}));

const { mockStudioEventCreate } = vi.hoisted(() => ({
  mockStudioEventCreate: vi.fn().mockResolvedValue({}),
}));

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: { studioEvent: { create: mockStudioEventCreate } },
}));

vi.mock('../cli-adapter.js', () => ({
  buildSpawnArgs: vi.fn(() => ({
    command: 'echo',
    args: [],
    env: {},
    promptViaStdin: false,
  })),
}));

vi.mock('../cli-scanner.js', () => ({}));

const { mockChild, spawnMock } = vi.hoisted(() => {
  const EventEmitter = require('events').EventEmitter;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.pid = 12345;
  const spawn = vi.fn(() => child);
  return { mockChild: child, spawnMock: spawn };
});

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: spawnMock };
});

import { TaskExecutor, type TaskExecutorConfig } from '../task-executor.js';
import type { ClaimedTask } from '../claim-loop.js';

function makeConfig(): TaskExecutorConfig {
  return {
    serverUrl: 'http://localhost:3000',
    token: 'st_mach_test',
    workspaceId: 'ws-1',
    workspaceRoot: '/tmp/test-ws',
    runtimes: [{ provider: 'claude', path: '/usr/bin/claude', version: '1.0.0' }],
    cancelPollMs: 100,
    timeoutMs: 10_000,
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
    modelTier: 'standard',
    sessionId: 'sess-1',
    status: 'running',
    createdAt: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

function emitStdoutToolUse(tool: string, input: Record<string, unknown>) {
  const line = JSON.stringify({
    type: 'assistant',
    content: [{ type: 'tool_use', name: tool, input }],
  });
  mockChild.stdout.emit('data', Buffer.from(line + '\n'));
}

/** Capture all prisma calls via fresh mockImplementation per test */
function captureCalls(): unknown[][] {
  const calls: unknown[][] = [];
  mockStudioEventCreate.mockImplementation((...args: unknown[]) => {
    calls.push(args);
    return Promise.resolve({});
  });
  return calls;
}

describe('TaskExecutor daemon-event-capture', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-events-test-'));
    mockStudioEventCreate.mockReset();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    // Prevent listener accumulation across tests (mockChild is a singleton)
    mockChild.stdout.removeAllListeners('data');
    mockChild.stderr.removeAllListeners('data');
    mockChild.removeAllListeners('exit');
    mockChild.removeAllListeners('error');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('tool_use block triggers StudioEvent create for tool:call', async () => {
    const calls = captureCalls();

    process.nextTick(() => {
      emitStdoutToolUse('Read', { file_path: '/src/app.ts' });
      mockChild.emit('exit', 0);
    });

    const executor = new TaskExecutor(makeConfig());
    await executor.execute(makeTask());

    const toolCall = calls.find(([arg]) => {
      const d = (arg as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
      return d?.type === 'tool:call';
    });
    expect(toolCall).toBeDefined();
    const data = (toolCall![0] as Record<string, unknown>).data as Record<string, unknown>;
    const payload = JSON.parse(data.payload as string);
    expect(payload.tool).toBe('Read');
    expect(payload.sessionId).toBe('sess-1');
    expect(data.source).toBe('executor');
  });

  it('Write tool triggers both tool:call and file:change events', async () => {
    const calls = captureCalls();

    process.nextTick(() => {
      emitStdoutToolUse('Write', { file_path: '/src/new-file.ts', content: 'const x = 1;' });
      mockChild.emit('exit', 0);
    });

    const executor = new TaskExecutor(makeConfig());
    await executor.execute(makeTask());

    const toolCall = calls.find(([arg]) => ((arg as Record<string, unknown>)?.data as Record<string, unknown>)?.type === 'tool:call');
    const fileChange = calls.find(([arg]) => ((arg as Record<string, unknown>)?.data as Record<string, unknown>)?.type === 'file:change');
    expect(toolCall).toBeDefined();
    expect(fileChange).toBeDefined();

    const fcData = (fileChange![0] as Record<string, unknown>).data as Record<string, unknown>;
    const fcPayload = JSON.parse(fcData.payload as string);
    expect(fcPayload.path).toBe('/src/new-file.ts');
    expect(fcPayload.sessionId).toBe('sess-1');
  });

  it('Edit tool triggers both tool:call and file:change events', async () => {
    const calls = captureCalls();

    process.nextTick(() => {
      emitStdoutToolUse('Edit', { file_path: '/src/app.ts', old_string: 'a', new_string: 'b' });
      mockChild.emit('exit', 0);
    });

    const executor = new TaskExecutor(makeConfig());
    await executor.execute(makeTask());

    const fileChange = calls.find(([arg]) => ((arg as Record<string, unknown>)?.data as Record<string, unknown>)?.type === 'file:change');
    expect(fileChange).toBeDefined();
    const fcData = (fileChange![0] as Record<string, unknown>).data as Record<string, unknown>;
    const fcPayload = JSON.parse(fcData.payload as string);
    expect(fcPayload.path).toBe('/src/app.ts');
  });

  it('sessionId fallback to task.id when sessionId is null', async () => {
    const calls = captureCalls();

    process.nextTick(() => {
      emitStdoutToolUse('Bash', { command: 'ls' });
      mockChild.emit('exit', 0);
    });

    const executor = new TaskExecutor(makeConfig());
    await executor.execute(makeTask({ sessionId: null }));

    expect(calls.length).toBeGreaterThan(0);
    const toolCall = calls.find(([arg]) => ((arg as Record<string, unknown>)?.data as Record<string, unknown>)?.type === 'tool:call');
    expect(toolCall).toBeDefined();
    const data = (toolCall![0] as Record<string, unknown>).data as Record<string, unknown>;
    const payload = JSON.parse(data.payload as string);
    expect(payload.sessionId).toBe('task-1');
  });

  it('StudioEvent write failure does not block stdout processing', async () => {
    mockStudioEventCreate.mockRejectedValue(new Error('DB down'));

    process.nextTick(() => {
      emitStdoutToolUse('Write', { file_path: '/src/app.ts', content: 'x' });
      mockChild.stdout.emit('data', Buffer.from('{"type":"result","result":"done"}\n'));
      mockChild.emit('exit', 0);
    });

    const executor = new TaskExecutor(makeConfig());
    await executor.execute(makeTask());

    // executor should still complete normally — result line was processed
    const completeCall = fetchMock.mock.calls.find(
      (c: unknown[]) => String(c[0]).includes('/complete'),
    );
    expect(completeCall).toBeDefined();
  });
});
