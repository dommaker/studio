/**
 * KnowledgeBus sync 进程泄漏修复测试 (B48-2E)
 *
 * 验证：
 * 1. execFile 替代 exec（消除 shell wrapper）
 * 2. 重试无上限（不再 5 次放弃）
 * 3. 退避 cap 120s
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('scheduleVectorDbSync (B48-2E)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function loadService(execFileMock: ReturnType<typeof vi.fn>) {
    vi.doMock('child_process', () => ({ execFile: execFileMock }));
    vi.doMock('@dommaker/studio-prisma', () => ({
      prisma: { studioEvent: { create: vi.fn().mockResolvedValue({ id: 'mock' }) } },
    }));
    vi.doMock('@dommaker/studio-shared', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));
    vi.doMock('@dommaker/harness', () => ({
      FileKnowledgeStore: class { list() { return []; } },
      KnowledgeIngest: class { ingestEntry() { return { id: 'x' }; } },
      KnowledgeLifecycle: class { shouldAutoPromote() { return false; } },
      KnowledgeQuery: class {},
      KnowledgeInjector: class {},
      KnowledgeLinter: class { validateEntry() { return []; } },
      ReferenceTracker: class {},
    }));
    return await import('../knowledge-bus.service.js');
  }

  it('uses execFile (not exec) — eliminates shell wrapper', async () => {
    const execFileMock = vi.fn().mockReturnValue({ pid: 123 });
    const { scheduleVectorDbSync } = await loadService(execFileMock);

    scheduleVectorDbSync();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = execFileMock.mock.calls[0];
    expect(cmd).toBe('nice');
    expect(Array.isArray(args)).toBe(true);
    expect(args).toContain('-n');
    expect(args).toContain('10');
    expect(args).toContain('mcp-local-rag');
    expect(args).toContain('ingest');
    expect(args).toContain('--db-path');
    expect(args).toContain('--base-dir');
  });

  it('retries indefinitely — does NOT give up after 5 attempts', async () => {
    const execFileMock = vi.fn().mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error) => void) => {
      process.nextTick(() => cb(new Error('sync failed')));
      return { pid: 123 };
    });
    const { scheduleVectorDbSync } = await loadService(execFileMock);

    // Initial call
    scheduleVectorDbSync();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(execFileMock).toHaveBeenCalledTimes(1);

    // Advance through 10 retries (exponential backoff)
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(200_000);
    }

    // Should have been called 11 times total (1 initial + 10 retries)
    expect(execFileMock.mock.calls.length).toBeGreaterThanOrEqual(10);
  });

  it('backoff caps at 120s', async () => {
    const backoffValues: number[] = [];
    const loggerWarn = vi.fn().mockImplementation((_msg: string, meta: { backoffSec?: number }) => {
      if (meta?.backoffSec !== undefined) backoffValues.push(meta.backoffSec);
    });

    const execFileMock = vi.fn().mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error) => void) => {
      process.nextTick(() => cb(new Error('sync failed')));
      return { pid: 123 };
    });

    vi.doMock('child_process', () => ({ execFile: execFileMock }));
    vi.doMock('@dommaker/studio-prisma', () => ({
      prisma: { studioEvent: { create: vi.fn().mockResolvedValue({ id: 'mock' }) } },
    }));
    vi.doMock('@dommaker/studio-shared', () => ({
      logger: { info: vi.fn(), warn: loggerWarn, error: vi.fn() },
    }));
    vi.doMock('@dommaker/harness', () => ({
      FileKnowledgeStore: class { list() { return []; } },
      KnowledgeIngest: class { ingestEntry() { return { id: 'x' }; } },
      KnowledgeLifecycle: class { shouldAutoPromote() { return false; } },
      KnowledgeQuery: class {},
      KnowledgeInjector: class {},
      KnowledgeLinter: class { validateEntry() { return []; } },
      ReferenceTracker: class {},
    }));
    const { scheduleVectorDbSync } = await import('../knowledge-bus.service.js');

    scheduleVectorDbSync();

    // Advance enough for 6 retries: 5+10+20+40+80+120+120 = 395s
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
    }

    // backoffValues: [10, 20, 40, 80, 120, 120, ...]
    expect(backoffValues.length).toBeGreaterThanOrEqual(5);
    expect(backoffValues[0]).toBe(10);
    expect(backoffValues[1]).toBe(20);
    expect(backoffValues[2]).toBe(40);
    expect(backoffValues[3]).toBe(80);
    // All values from index 4 onward must be capped at 120
    for (let i = 4; i < backoffValues.length; i++) {
      expect(backoffValues[i]).toBeLessThanOrEqual(120);
    }
  });
});
