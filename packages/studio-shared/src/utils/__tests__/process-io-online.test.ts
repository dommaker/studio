/**
 * Behavioral test: execSh onLine 行级回调（Layer B 步内流式的数据源）。
 *
 * AC:
 *   1. 每个完整行到达即回调（不等进程结束，增量性用 sleep 间隔证明）
 *   2. 进程关闭时冲刷无换行结尾的尾部行
 *   3. 回调抛异常不影响被观测进程（stdout 聚合与退出码不受影响）
 */
import { describe, test, expect } from 'vitest';
import { execSh } from '../process-io';

const baseOpts = { cwd: '/tmp', timeoutMs: 10_000 };

describe('execSh onLine', () => {
  test('fires per complete line', async () => {
    const lines: string[] = [];
    const { stdout } = await execSh("printf 'a\\nb\\nc\\n'", {
      ...baseOpts,
      onLine: (l) => lines.push(l),
    });
    expect(lines).toEqual(['a', 'b', 'c']);
    // 与聚合返回值并行存在、互不影响
    expect(stdout).toBe('a\nb\nc\n');
  });

  test('fires incrementally, not buffered to process end', async () => {
    let firstLineAt = 0;
    const started = Date.now();
    await execSh('echo first; sleep 0.6; echo second', {
      ...baseOpts,
      onLine: (l) => { if (l === 'first' && firstLineAt === 0) firstLineAt = Date.now(); },
    });
    const elapsed = Date.now() - started;
    expect(firstLineAt).toBeGreaterThan(0);
    // 若缓冲到进程结束才回调，first 到达时间 ≈ 总耗时（≥600ms）；
    // 增量回调应在 sleep 完成前很久就到达
    expect(elapsed - (firstLineAt - started)).toBeGreaterThan(300);
  });

  test('flushes unterminated tail line on close', async () => {
    const lines: string[] = [];
    await execSh("printf 'a\\nb'", { ...baseOpts, onLine: (l) => lines.push(l) });
    expect(lines).toEqual(['a', 'b']);
  });

  test('callback throw does not affect the observed process', async () => {
    const { stdout } = await execSh("printf 'x\\ny\\n'", {
      ...baseOpts,
      onLine: () => { throw new Error('observer bug'); },
    });
    expect(stdout).toBe('x\ny\n');
  });

  test('no onLine option keeps prior behavior', async () => {
    const { stdout } = await execSh('echo plain', baseOpts);
    expect(stdout.trim()).toBe('plain');
  });
});
