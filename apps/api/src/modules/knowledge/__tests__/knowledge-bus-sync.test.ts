/**
 * scheduleVectorDbSync 测试（B48-2E + 向量库同步加固 df5f899 + R4 模块迁移 + P4 日志策略）
 *
 * 验证：
 * 1. execFile 替代 exec（消除 shell wrapper），经 systemd-run 加 700M 内存帽 + flock 单写者
 * 2. 失败重试：指数退避 cap 120s，cap 10 次；P4 修订——空输出 = flock 锁竞争静默重排
 *    （不告警不计失败），真实失败每个 episode 只 warn 一次（带 stderr 尾部），重试走
 *    debug，放弃 error 一次，恢复 info 一次
 * 3. R4: 函数所有权在 knowledge-singletons.ts，knowledge-bus.service.js 保持兼容 re-export
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

function mockDeps(execFileMock: ReturnType<typeof vi.fn>, loggerWarn?: ReturnType<typeof vi.fn>, loggerDebug?: ReturnType<typeof vi.fn>, loggerError?: ReturnType<typeof vi.fn>, loggerInfo?: ReturnType<typeof vi.fn>) {
  vi.doMock('child_process', () => ({ execFile: execFileMock, execFileSync: vi.fn() }));
  vi.doMock('@dommaker/studio-shared', () => ({
    logger: { info: loggerInfo ?? vi.fn(), warn: loggerWarn ?? vi.fn(), error: loggerError ?? vi.fn(), debug: loggerDebug ?? vi.fn() },
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
  // flake 加固（工单 43-B1）：mock execFile 同步触发回调。原 process.nextTick
  // 写法游离于假时钟外，依赖 advanceTimersByTimeAsync 内部 yield 与 nextTick
  // 队列的交错时序，全量跑 CPU 竞争下 logger 计数断言偶发漂移；setTimeout(cb,0)
  // 变体则撞上 sinon 边界语义——推进窗口内新建、到期点恰等于窗口终点的定时器
  // 本轮不触发。同步回调使全部状态迁移发生在定时器触发栈内，完全确定。
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

  it('real failure (with output): warn once per episode with stderr tail, retries silent, give-up error at >10', async () => {
    const loggerWarn = vi.fn();
    const loggerDebug = vi.fn();
    const loggerError = vi.fn();
    const execFileMock = vi.fn().mockImplementation((_c: string, _a: string[], _o: unknown, cb: (err: Error, stdout: string, stderr: string) => void) => {
      cb(new Error('Command failed: systemd-run ...'),
        'Found 1905 file(s) to ingest.\nVectorStore initialized',
        'EmbeddingError: ONNX runtime crashed — real reason at the TAIL');
      return { pid: 123 };
    });
    mockDeps(execFileMock, loggerWarn, loggerDebug, loggerError);
    const { scheduleVectorDbSync } = await import('../knowledge-singletons.js');

    scheduleVectorDbSync();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    // 首次失败：warn 一次，带 stderr 尾部（含真实原因）
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    const warnMeta = loggerWarn.mock.calls[0][1] as { attempt: number; errorTail: string };
    expect(warnMeta.attempt).toBe(1);
    expect(warnMeta.errorTail).toContain('real reason at the TAIL');

    // 继续失败：不再 warn，走 debug；多次重试仍在跑（未提前放弃）
    await vi.advanceTimersByTimeAsync(200_000);
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    expect(loggerDebug.mock.calls.some(c => (c[0] as string).includes('retry failed'))).toBe(true);
    expect(execFileMock.mock.calls.length).toBeGreaterThanOrEqual(5);

    // 推进到 >10 次失败 → give-up error 一次
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(200_000);
    const giveUpCalls = loggerError.mock.calls.filter(c => (c[0] as string).includes('gave up'));
    expect(giveUpCalls).toHaveLength(1);
    // give-up 后不再重排
    const callsAtGiveUp = execFileMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(400_000);
    expect(execFileMock.mock.calls.length).toBe(callsAtGiveUp);
    expect(loggerWarn).toHaveBeenCalledTimes(1);
  });

  it('empty output failure = flock 锁竞争：静默重排，不 warn 不计失败', async () => {
    const loggerWarn = vi.fn();
    const loggerDebug = vi.fn();
    const execFileMock = vi.fn().mockImplementation((_c: string, _a: string[], _o: unknown, cb: (err: Error, stdout: string, stderr: string) => void) => {
      cb(new Error('Command failed: systemd-run ...'), '', '');
      return { pid: 123 };
    });
    mockDeps(execFileMock, loggerWarn, loggerDebug);
    const { scheduleVectorDbSync } = await import('../knowledge-singletons.js');

    scheduleVectorDbSync();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(execFileMock).toHaveBeenCalledTimes(1);

    // 锁竞争重排：15s + 5s 防抖节奏，持续空输出失败也不 warn、不走退避计数
    await vi.advanceTimersByTimeAsync(120_000);
    expect(execFileMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(loggerWarn).not.toHaveBeenCalled();
    expect(loggerDebug.mock.calls.some(c => (c[0] as string).includes('lock held'))).toBe(true);
  });

  it('失败后恢复 → info 记录 recovered（一个 episode 结束）', async () => {
    const loggerWarn = vi.fn();
    const loggerInfo = vi.fn();
    let calls = 0;
    const execFileMock = vi.fn().mockImplementation((_c: string, _a: string[], _o: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      calls++;
      if (calls <= 2) {
        cb(new Error('Command failed'), 'Found 10 file(s)', 'boom');
      } else {
        cb(null, 'Succeeded: 2\nFailed: 0\nTotal chunks: 4', '');
      }
      return { pid: 123 };
    });
    mockDeps(execFileMock, loggerWarn, undefined, undefined, loggerInfo);
    const { scheduleVectorDbSync } = await import('../knowledge-singletons.js');

    scheduleVectorDbSync();
    await vi.advanceTimersByTimeAsync(5_000);   // 第 1 次失败（warn）
    await vi.advanceTimersByTimeAsync(20_000);  // 第 2 次失败（debug）
    await vi.advanceTimersByTimeAsync(40_000);  // 第 3 次成功
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    expect(loggerInfo.mock.calls.some(c => (c[0] as string).includes('recovered'))).toBe(true);
    expect(loggerInfo.mock.calls.some(c => (c[0] as string).includes('synced'))).toBe(true);
  });

  it('backoff caps at 120s（真实失败时按指数退避重排）', async () => {
    // 通过 execFile 调用时间点验证退避序列 10/20/40/80/120/120...（每次重排另加 5s 防抖）
    const callTimes: number[] = [];
    vi.setSystemTime(0);
    const execFileMock = vi.fn().mockImplementation((_c: string, _a: string[], _o: unknown, cb: (err: Error, stdout: string, stderr: string) => void) => {
      callTimes.push(Date.now());
      cb(new Error('Command failed'), 'Found 10 file(s)', 'boom');
      return { pid: 123 };
    });
    mockDeps(execFileMock);
    const { scheduleVectorDbSync } = await import('../knowledge-singletons.js');

    scheduleVectorDbSync();
    // 逐步推进：5s 防抖后第 1 次；之后 (backoff + 5s 防抖) 节奏。
    // 第二步 +1ms：sinon 对"推进窗口内新建、到期点恰等于窗口终点"的定时器本轮
    // 不触发（留到下一轮）；第 2 次执行到期点 20s 恰等于原窗口终点会漏触发，
    // 导致后续断言少一次调用。垫 1ms 后各执行到期点均严格小于窗口终点，
    // 到期点本身（Date.now 口径）不变，gap 断言不受影响。
    const steps = [5_000, 15_001, 25_000, 45_000, 85_000, 125_000, 125_000];
    for (const s of steps) {
      await vi.advanceTimersByTimeAsync(s);
    }
    expect(callTimes.length).toBeGreaterThanOrEqual(7);
    const gaps = callTimes.slice(1).map((t, i) => t - callTimes[i]);
    // 每次重排 = backoff + 5s 防抖
    expect(gaps[0]).toBe(10_000 + 5_000);
    expect(gaps[1]).toBe(20_000 + 5_000);
    expect(gaps[2]).toBe(40_000 + 5_000);
    expect(gaps[3]).toBe(80_000 + 5_000);
    // cap 120s
    for (let i = 4; i < gaps.length; i++) {
      expect(gaps[i]).toBe(120_000 + 5_000);
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
