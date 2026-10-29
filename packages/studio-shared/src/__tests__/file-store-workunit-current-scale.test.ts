import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { WorkUnitStore } from '../file-store/file-store-workunit';
import { createFileStoreCore, type FileStoreCore } from '../file-store/file-store-core';
import type { WorkUnitEvent, WorkUnitSnapshot } from '../file-store/file-store-types';
import { workUnitProjectionFileName } from '../file-store/workunit-current-projection';

const ACTIVE_WUS = 10_000;
const INDEX_ROWS = 100_000;

function snapshot(id: string, overrides: Partial<WorkUnitSnapshot> = {}): WorkUnitSnapshot {
  return {
    id, parentId: null, type: 'task', scope: `scope-${id}`, assigneeId: null,
    status: 'unassigned', failureType: null, retryCount: 0, timeoutAt: null,
    channelId: null, projectPath: null, metadata: '{"count":0}',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    claimedAt: null, completedAt: null, ...overrides,
  };
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

describe('PERF-02 规模读取量与并发', () => {
  let root: string;
  let core: FileStoreCore;
  let store: WorkUnitStore;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-current-scale-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('1万活 WU/10万 index 行：点查读取量有界，20 写者无丢失更新', async () => {
    const workunits = path.join(root, 'workunits');
    const currentDir = path.join(workunits, 'current');
    fs.mkdirSync(currentDir, { recursive: true });
    const events: string[] = [];
    const index: string[] = [];
    const latest = new Map<string, WorkUnitSnapshot>();
    for (let i = 0; i < ACTIVE_WUS; i++) {
      const id = i === 0 ? 'wu-lease' : `wu-${String(i).padStart(5, '0')}`;
      const claimedAt = '2026-01-01T00:00:00.000Z';
      const snap = snapshot(id, i === 0 ? {
        status: 'active', assigneeId: 'inst-lease', claimedAt,
        timeoutAt: '2026-01-01T00:05:00.000Z',
      } : {});
      latest.set(id, snap);
      events.push(JSON.stringify({ type: 'created', wuId: id, timestamp: snap.createdAt, data: snap }));
      for (let version = 0; version < INDEX_ROWS / ACTIVE_WUS - 1; version++) {
        index.push(JSON.stringify({ ...snap, scope: `history-${version}` }));
      }
      index.push(JSON.stringify(snap));
    }
    const eventsPath = path.join(workunits, 'events.jsonl');
    fs.writeFileSync(eventsPath, `${events.join('\n')}\n`);
    fs.writeFileSync(path.join(workunits, 'index.json'), `${index.join('\n')}\n`);
    const stat = fs.statSync(eventsPath);
    const head = { dev: stat.dev, ino: stat.ino, offset: stat.size };
    const headsDir = path.join(currentDir, 'heads');
    fs.mkdirSync(headsDir);
    for (const snap of latest.values()) {
      const fileName = workUnitProjectionFileName(snap.id);
      fs.writeFileSync(path.join(currentDir, fileName), JSON.stringify({ version: 1, log: head, snapshot: snap }));
      fs.writeFileSync(path.join(headsDir, fileName), JSON.stringify({ version: 1, log: head }));
    }
    fs.writeFileSync(path.join(currentDir, 'manifest.json'), JSON.stringify({ version: 1, log: head, count: ACTIVE_WUS }));

    core = createFileStoreCore(root);
    store = new WorkUnitStore(core);
    const readFile = fs.promises.readFile.bind(fs.promises);
    let readBytes = 0;
    let historyReads = 0;
    let parseRows = 0;
    vi.spyOn(fs.promises, 'readFile').mockImplementation((async (file: fs.PathLike | fs.promises.FileHandle, options?: unknown) => {
      const result = await readFile(file as fs.PathLike, options as { encoding?: BufferEncoding | null });
      readBytes += Buffer.isBuffer(result) ? result.byteLength : Buffer.byteLength(String(result));
      if (String(file).endsWith(`${path.sep}index.json`)) historyReads++;
      return result;
    }) as typeof fs.promises.readFile);
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation(async (file, flags, mode) => {
      const handle = await open(file, flags, mode);
      const read = handle.read.bind(handle);
      vi.spyOn(handle, 'read').mockImplementation(async (...args) => {
        const result = await read(...args);
        readBytes += result.bytesRead;
        return result;
      });
      return handle;
    });
    const jsonParse = JSON.parse;
    vi.spyOn(JSON, 'parse').mockImplementation(text => {
      parseRows++;
      return jsonParse(text);
    });
    const measurements: Record<string, { readBytes: number; parseRows: number; historyReads: number }> = {};
    const measure = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      readBytes = 0;
      historyReads = 0;
      parseRows = 0;
      const result = await fn();
      measurements[name] = { readBytes, parseRows, historyReads };
      expect(historyReads).toBe(0);
      expect(readBytes).toBeLessThan(32_768);
      expect(parseRows).toBeLessThanOrEqual(8);
      return result;
    };

    await measure('updateMetadata', () => store.updateMetadata('wu-00001', current => ({ ...current, count: 1 })));
    expect(await measure('claim', () => store.claimWorkUnit('wu-00002', 'inst-claim'))).toBe(true);
    const leaseDate = new Date('2026-01-01T00:06:00.000Z');
    expect(await store.refreshWorkUnitLease('wu-lease', 'inst-lease', '2026-01-01T00:00:00.000Z', leaseDate)).toBe('ok');
    expect(await measure('leaseFlush', () => store.flushWorkUnitLeases())).toEqual({ flushed: 1, dropped: 0 });
    readBytes = 0;
    historyReads = 0;
    parseRows = 0;
    const guarded = await store.createSnapshotGuarded(snapshot('guard-candidate'), snapshots => snapshots.length !== ACTIVE_WUS);
    measurements.guardedCreate = { readBytes, parseRows, historyReads };
    expect(guarded).toBe(false);
    expect(historyReads).toBe(0);
    expect(parseRows).toBe(ACTIVE_WUS * 3 + 1); // 全局 manifest + 每 WU projection/head/内容解析，与历史行数无关
    vi.restoreAllMocks();

    const runConcurrent = async (
      operation: (writer: number, iteration: number) => Promise<void>,
    ) => {
      const baseWithLock = core.base.withLock.bind(core.base);
      const lockWaits: number[] = [];
      const lockSpy = vi.spyOn(core.base, 'withLock').mockImplementation(async (lockDir, fn, timeoutMs) => {
        const started = performance.now();
        return baseWithLock(lockDir, async () => {
          lockWaits.push(performance.now() - started);
          return fn();
        }, timeoutMs);
      });
      const latencies: number[] = [];
      const errors: unknown[] = [];
      await Promise.all(Array.from({ length: 20 }, (_, writer) => (async () => {
        for (let iteration = 0; iteration < 5; iteration++) {
          const started = performance.now();
          try {
            await operation(writer, iteration);
            latencies.push(performance.now() - started);
          } catch (error) {
            errors.push(error);
          }
        }
      })()));
      lockSpy.mockRestore();
      expect(errors).toEqual([]);
      expect(latencies).toHaveLength(100);
      expect(lockWaits.length).toBeGreaterThan(0);
      return {
        writers: 20,
        operations: latencies.length,
        latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: Math.max(...latencies) },
        lockWaitMs: { p50: percentile(lockWaits, 0.5), p95: percentile(lockWaits, 0.95), max: Math.max(...lockWaits) },
        timeout5sRate: errors.length / 100,
      };
    };

    const concurrency = {
      updateMetadata: await runConcurrent(async writer => {
        const id = `wu-${String(writer + 100).padStart(5, '0')}`;
        await store.updateMetadata(id, current => ({ ...current, count: (current.count as number) + 1 }));
      }),
      claim: await runConcurrent(async writer => {
        const id = `wu-${String(writer + 200).padStart(5, '0')}`;
        await store.claimWorkUnit(id, `inst-claim-${writer}`);
      }),
    };
    const leaseClaimedAt = new Map<number, string>();
    await Promise.all(Array.from({ length: 20 }, async (_, writer) => {
      const id = `wu-${String(writer + 300).padStart(5, '0')}`;
      expect(await store.claimWorkUnit(id, `inst-lease-${writer}`)).toBe(true);
      leaseClaimedAt.set(writer, (await store.getIndex({ id }))[0].claimedAt!);
    }));
    const finalLease = '2026-01-01T00:20:00.000Z';
    const leaseFlush = await runConcurrent(async (writer, iteration) => {
      const id = `wu-${String(writer + 300).padStart(5, '0')}`;
      const timeoutAt = iteration === 4 ? new Date(finalLease) : new Date(`2026-01-01T00:1${iteration}:00.000Z`);
      expect(await store.refreshWorkUnitLease(id, `inst-lease-${writer}`, leaseClaimedAt.get(writer)!, timeoutAt)).toBe('ok');
      await store.flushWorkUnitLeases();
    });
    console.info('PERF-02 scale measurements', JSON.stringify({
      scale: { activeWus: ACTIVE_WUS, indexRows: INDEX_ROWS }, reads: measurements,
      concurrency: { ...concurrency, leaseFlush },
    }));

    const expectedById = new Map<string, WorkUnitSnapshot>();
    const eventRows = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as WorkUnitEvent);
    for (const row of eventRows) {
      if (row.type === 'created') {
        expectedById.set(row.wuId, row.data as unknown as WorkUnitSnapshot);
      } else if (row.type === 'closed' && row.data?.deleted === true) {
        expectedById.delete(row.wuId);
      } else {
        const current = expectedById.get(row.wuId);
        if (current && row.data) expectedById.set(row.wuId, { ...current, ...row.data } as WorkUnitSnapshot);
      }
    }
    const rebuilt = [...expectedById.values()];
    for (let writer = 0; writer < 20; writer++) {
      const updateId = `wu-${String(writer + 100).padStart(5, '0')}`;
      expect(JSON.parse(rebuilt.find(row => row.id === updateId)!.metadata!).count).toBe(5);
      const claim = rebuilt.find(row => row.id === `wu-${String(writer + 200).padStart(5, '0')}`)!;
      expect(claim.status).toBe('active');
      expect(claim.assigneeId).toBe(`inst-claim-${writer}`);
      const lease = rebuilt.find(row => row.id === `wu-${String(writer + 300).padStart(5, '0')}`)!;
      expect(lease.status).toBe('active');
      expect(lease.assigneeId).toBe(`inst-lease-${writer}`);
      expect(lease.timeoutAt).toBe(finalLease);
    }
  }, 180_000);
});
