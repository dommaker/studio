/**
 * scheduleVectorDbSync 测试（B48-2E + 向量库同步加固 df5f899 + R4 模块迁移）
 *
 * 验证：
 * 1. execFile 替代 exec（消除 shell wrapper），经 systemd-run 加 700M 内存帽 + flock 单写者
 * 2. 失败重试：指数退避 cap 120s，cap 10 次
 * 3. R4: 函数所有权在 knowledge-singletons.ts，knowledge-bus.service.js 保持兼容 re-export
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

function mockDeps(execFileMock: ReturnType<typeof vi.fn>, loggerWarn?: ReturnType<typeof vi.fn>) {
  vi.doMock('child_process', () => ({ execFile: execFileMock, execFileSync: vi.fn() }));
  vi.doMock('@dommaker/studio-shared', () => ({
    logger: { info: vi.fn(), warn: loggerWarn ?? vi.fn(), error: vi.fn() },
    FileStore: class {
      appendJsonl = vi.fn().mockResolvedValue(undefined);
    },
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
}

describe('scheduleVectorDbSync (B48-2E)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('uses execFile via systemd-run scope — mem cap + flock + nice (no shell wrapper)', async () => {
    const execFileMock = vi.fn().mockReturnValue({ pid: 123 });
    mockDeps(execFileMock);
    const { scheduleVectorDbSync } = await import('../knowledge-singletons.js');

    scheduleVectorDbSync();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = execFileMock.mock.calls[0];
    expect(cmd).toBe('systemd-run');
    expect(Array.isArray(args)).toBe(true);
    // 700M 内存帽
    expect(args).toContain('MemoryMax=700M');
    // flock 单写者
    expect(args).toContain('flock');
    expect(args).toContain('/tmp/vector-db-sync.lock');
    // 降优先级执行 mcp-local-rag ingest
    expect(args).toContain('nice');
    expect(args).toContain('-n');
    expect(args).toContain('10');
    expect(args).toContain('mcp-local-rag');
    expect(args).toContain('ingest');
    expect(args).toContain('--db-path');
    expect(args).toContain('--base-dir');
  });

  it('retries with exponential backoff — does NOT give up before 10 attempts', async () => {
    const execFileMock = vi.fn().mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error) => void) => {
      process.nextTick(() => cb(new Error('sync failed')));
      return { pid: 123 };
    });
    mockDeps(execFileMock);
    const { scheduleVectorDbSync } = await import('../knowledge-singletons.js');

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
    mockDeps(execFileMock, loggerWarn);
    const { scheduleVectorDbSync } = await import('../knowledge-singletons.js');

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

  it('R4: knowledge-bus.service.js re-exports the same scheduleVectorDbSync (compat)', async () => {
    const execFileMock = vi.fn().mockReturnValue({ pid: 123 });
    mockDeps(execFileMock);
    const singletons = await import('../knowledge-singletons.js');
    const bus = await import('../knowledge-bus.service.js');
    expect(bus.scheduleVectorDbSync).toBe(singletons.scheduleVectorDbSync);
    expect(bus.isVectorDbSyncing).toBe(singletons.isVectorDbSyncing);
    expect(bus.sharedStore).toBe(singletons.sharedStore);
  });
});
