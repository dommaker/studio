/**
 * PERF-01：写侧 direct-apply 的读取量/解析量门禁。
 *
 * 历史分别取 10 万与 100 万行；初始回填后连续写 100 条事件。
 * 稳态读取字节不得超过新增事件字节，事件 JSON.parse 行数必须为 0；
 * 锁等待与 event-loop delay 只记录诊断，硬阈值归 PERF-07。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import { performance } from 'node:perf_hooks';
import { writeWorkunitTokenEvent } from '../../agent-loop/agent-loop-events.js';
import { getStore } from '../../../core/store.js';
import { syncTokenLedger } from '../token-ledger.js';

let dir: string;
let eventsFile: string;

function tokenLine(workUnitId: string, executionTokens: number): string {
  return JSON.stringify({
    type: 'workunit:tokens',
    source: 'agent-loop',
    payload: JSON.stringify({ workUnitId, injectedTokens: 1, executionTokens }),
    createdAt: new Date(0).toISOString(),
  }) + '\n';
}

function seedHistory(lines: number): void {
  const chunk = tokenLine('wu-history', 1).repeat(1_000);
  const fd = fs.openSync(eventsFile, 'w', 0o600);
  try {
    for (let written = 0; written < lines; written += 1_000) {
      const remaining = lines - written;
      fs.writeFileSync(fd, remaining >= 1_000 ? chunk : chunk.slice(0, Buffer.byteLength(tokenLine('wu-history', 1)) * remaining));
    }
  } finally {
    fs.closeSync(fd);
  }
}

function instrumentEventReads(file: string): { bytes: () => number; parsedLines: () => number; restore: () => void } {
  let bytes = 0;
  let parsedLines = 0;
  const originalReadFile = fs.promises.readFile.bind(fs.promises);
  const originalOpen = fs.promises.open.bind(fs.promises);
  const originalParse = JSON.parse;

  const readFileSpy = vi.spyOn(fs.promises, 'readFile').mockImplementation((async (target: fs.PathLike, ...args: unknown[]) => {
    const result = await (originalReadFile as (...a: unknown[]) => Promise<Buffer | string>)(target, ...args);
    if (String(target) === file) bytes += Buffer.byteLength(result);
    return result;
  }) as typeof fs.promises.readFile);
  const openSpy = vi.spyOn(fs.promises, 'open').mockImplementation((async (target: fs.PathLike, ...args: unknown[]) => {
    const handle = await (originalOpen as (...a: unknown[]) => Promise<fs.promises.FileHandle>)(target, ...args);
    if (String(target) === file) {
      const originalRead = handle.read.bind(handle);
      Object.defineProperty(handle, 'read', {
        value: async (...readArgs: unknown[]) => {
          const result = await (originalRead as (...a: unknown[]) => Promise<{ bytesRead: number }>)(...readArgs);
          bytes += result.bytesRead;
          return result;
        },
      });
    }
    return handle;
  }) as typeof fs.promises.open);
  const parseSpy = vi.spyOn(JSON, 'parse').mockImplementation((text: string, reviver?: (key: string, value: unknown) => unknown) => {
    if (text.startsWith('{"type":')) parsedLines += 1;
    return originalParse(text, reviver);
  });

  return {
    bytes: () => bytes,
    parsedLines: () => parsedLines,
    restore: () => {
      readFileSpy.mockRestore();
      openSpy.mockRestore();
      parseSpy.mockRestore();
    },
  };
}

function instrumentLockWaits(): { waits: number[]; restore: () => void } {
  const store = getStore();
  const waits: number[] = [];
  const originalWithLock = store.withLock.bind(store);
  const spy = vi.spyOn(store, 'withLock').mockImplementation(async (lockDir, fn, timeoutMs) => {
    const started = performance.now();
    return originalWithLock(lockDir, async () => {
      waits.push(performance.now() - started);
      return fn();
    }, timeoutMs);
  });
  return { waits, restore: () => spy.mockRestore() };
}

function diagnostics(history: number, reads: number, parsed: number, waits: number[], histogram: IntervalHistogram): void {
  const sorted = [...waits].sort((a, b) => a - b);
  console.info('[PERF-01] token ledger write diagnostics', JSON.stringify({
    history,
    writes: 100,
    eventBytesRead: reads,
    eventJsonLinesParsed: parsed,
    lockWaitP50Ms: sorted[Math.floor(sorted.length / 2)] ?? 0,
    lockWaitMaxMs: sorted.at(-1) ?? 0,
    eventLoopDelayMeanMs: histogram.mean / 1e6,
    eventLoopDelayMaxMs: histogram.max / 1e6,
  }));
}

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('PERF-01 token ledger 写侧复杂度', () => {
  it.each([100_000, 1_000_000])('%i 行历史后连续 100 次写入只读取新增事件', { timeout: 180_000 }, async (history) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), `token-ledger-perf-${history}-`));
    eventsFile = path.join(dir, 'studio-events.jsonl');
    seedHistory(history);
    await syncTokenLedger(eventsFile);

    const reads = instrumentEventReads(eventsFile);
    const locks = instrumentLockWaits();
    const histogram = monitorEventLoopDelay({ resolution: 1 });
    histogram.enable();
    let appendedBytes = 0;
    let previousReadBytes = 0;
    try {
      for (let i = 0; i < 100; i += 1) {
        const before = fs.statSync(eventsFile).size;
        await writeWorkunitTokenEvent(eventsFile, {
          workUnitId: 'wu-new',
          executionId: `execution-${i}`,
          injectedTokens: 2,
          executionTokens: i + 1,
        });
        const appendedThisWrite = fs.statSync(eventsFile).size - before;
        appendedBytes += appendedThisWrite;
        const readThisWrite = reads.bytes() - previousReadBytes;
        expect(readThisWrite).toBeLessThanOrEqual(appendedThisWrite);
        expect(reads.parsedLines()).toBe(0);
        previousReadBytes = reads.bytes();
      }
      histogram.disable();
      diagnostics(history, reads.bytes(), reads.parsedLines(), locks.waits, histogram);
      expect(reads.bytes()).toBeLessThanOrEqual(appendedBytes);
      expect(reads.parsedLines()).toBe(0);
    } finally {
      histogram.disable();
      locks.restore();
      reads.restore();
    }
  });
});
