/**
 * Claim Loop tests — P5-02 per-runtime polling
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { ClaimLoop, type ClaimedTask, type ClaimLoopConfig } from '../claim-loop.js';

function makeConfig(overrides?: Partial<ClaimLoopConfig>): ClaimLoopConfig {
  return {
    serverUrl: 'http://localhost:3000',
    token: 'st_mach_test',
    workspaceId: 'ws-1',
    pollIntervalMs: 50, // fast for testing
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

describe('ClaimLoop', () => {
  let handler: ReturnType<typeof vi.fn>;
  let loop: ClaimLoop;

  beforeEach(() => {
    fetchMock.mockReset();
    handler = vi.fn().mockResolvedValue(undefined);
    vi.useFakeTimers();
  });

  afterEach(() => {
    loop?.stopAll();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts and stops loop for a runtime', () => {
    loop = new ClaimLoop(makeConfig(), handler);
    loop.start('claude');
    expect(loop.getActiveRuntimes()).toEqual(['claude']);
    loop.stop('claude');
    expect(loop.getActiveRuntimes()).toEqual([]);
  });

  it('does not start duplicate loop', () => {
    loop = new ClaimLoop(makeConfig(), handler);
    loop.start('claude');
    loop.start('claude'); // duplicate
    expect(loop.getActiveRuntimes()).toEqual(['claude']);
  });

  it('polls and claims task', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ task: makeTask() }),
    });

    loop = new ClaimLoop(makeConfig({ pollIntervalMs: 50 }), handler);
    loop.start('claude');

    // Advance timer to trigger first poll
    await vi.advanceTimersByTimeAsync(60);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-1' }));
  });

  it('handles 204 (no task) gracefully', async () => {
    fetchMock.mockResolvedValueOnce({ status: 204, ok: false });

    loop = new ClaimLoop(makeConfig({ pollIntervalMs: 50 }), handler);
    loop.start('claude');

    await vi.advanceTimersByTimeAsync(60);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it('respects max concurrent limit', async () => {
    // Handler never resolves — simulates long-running task
    handler.mockReturnValue(new Promise(() => {}));
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ task: makeTask() }),
    });

    loop = new ClaimLoop(makeConfig({ pollIntervalMs: 50, maxConcurrent: 2 }), handler);
    loop.start('claude');

    // Poll 3 times (each 50ms)
    await vi.advanceTimersByTimeAsync(180);

    // Should have polled 3 times but only claimed 2 tasks (max concurrent)
    expect(handler).toHaveBeenCalledTimes(2);
    expect(loop.getActiveCount()).toBe(2);
  });

  it('sends correct auth header and body', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ task: makeTask() }),
    });

    loop = new ClaimLoop(makeConfig({ token: 'st_mach_secret' }), handler);
    loop.start('codex');

    await vi.advanceTimersByTimeAsync(60);

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/v1/daemon/tasks/claim');
    expect(opts.headers.Authorization).toBe('Bearer st_mach_secret');
    expect(JSON.parse(opts.body)).toEqual({ runtime_id: 'codex' });
  });

  it('continues polling after error', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ task: makeTask() }),
      });

    loop = new ClaimLoop(makeConfig({ pollIntervalMs: 50 }), handler);
    loop.start('claude');

    // First poll fails, second succeeds
    await vi.advanceTimersByTimeAsync(120);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('wakeup triggers immediate poll', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ task: makeTask() }),
    });

    loop = new ClaimLoop(makeConfig({ pollIntervalMs: 10_000 }), handler);
    loop.start('claude');

    // Don't wait for poll interval — wakeup immediately
    loop.wakeup('claude');
    await vi.advanceTimersByTimeAsync(1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stopAll stops all runtimes', () => {
    loop = new ClaimLoop(makeConfig(), handler);
    loop.start('claude');
    loop.start('codex');
    expect(loop.getActiveRuntimes()).toHaveLength(2);

    loop.stopAll();
    expect(loop.getActiveRuntimes()).toHaveLength(0);
  });
});
