/**
 * #323 阶段一：read-metrics sink 与 FileStore 四读口埋点测试（先行 RED）。
 *
 * 覆盖（计划 §测试）：
 *  - sink 开启时事件字段完整（readJson hit/miss、readJsonl、readIndexForQuery、readdir 各一例）
 *  - ALS 归因：嵌套 label 覆盖/恢复、无 label → 'unlabeled'、并发轮次不串 label
 *  - sink 关闭（默认 null）时读口行为不变
 * 零开销断言（spy）在 read-metrics-off.test.ts（模块 mock 需独立文件）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '../file-store';
import {
  setReadMetricsSink,
  runWithLoopLabel,
  type ReadMetricEvent,
} from '../read-metrics';

let tmpDir: string;
let store: FileStore;
let events: ReadMetricEvent[];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-metrics-'));
  store = new FileStore(tmpDir);
  events = [];
  setReadMetricsSink(e => events.push(e));
});

afterEach(() => {
  setReadMetricsSink(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeJson(rel: string, data: unknown): string {
  const p = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data));
  return p;
}

describe('readJson 埋点', () => {
  it('miss → hit：事件字段完整，cacheHit 与阶段耗时口径正确', async () => {
    const file = writeJson('agents/a1/state.json', { id: 'a1', status: 'running' });

    const v1 = await store.readJson(file);
    const v2 = await store.readJson(file);
    expect(v2).toEqual(v1);

    expect(events).toHaveLength(2);
    const [miss, hit] = events;
    for (const e of events) {
      expect(e.op).toBe('readJson');
      expect(e.file).toBe(file);
      expect(e.statMs).toBeGreaterThanOrEqual(0);
      expect(e.cloneMs).toBeGreaterThanOrEqual(0);
      expect(e.readParseMs).toBeGreaterThanOrEqual(0);
    }
    expect(miss.cacheHit).toBe(false);
    expect(miss.readParseMs).toBeGreaterThan(0);
    expect(hit.cacheHit).toBe(true);
    expect(hit.readParseMs).toBe(0);
  });

  it('文件不存在：仍记一次事件（stat 判缺），cacheHit=false 且无 readParse', async () => {
    const missing = path.join(tmpDir, 'nope.json');
    const v = await store.readJson(missing);
    expect(v).toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ op: 'readJson', file: missing, cacheHit: false, readParseMs: 0, cloneMs: 0 });
  });
});

describe('readJsonl 埋点', () => {
  it('miss → hit 各一记，行数正确', async () => {
    const file = path.join(tmpDir, 'events.jsonl');
    fs.writeFileSync(file, '{"a":1}\n{"a":2}\n');

    const rows1 = await store.readJsonl(file);
    await store.readJsonl(file);
    expect(rows1).toHaveLength(2);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ op: 'readJsonl', file, cacheHit: false });
    expect(events[0].readParseMs).toBeGreaterThan(0);
    expect(events[1]).toMatchObject({ op: 'readJsonl', file, cacheHit: true, readParseMs: 0 });
  });
});

describe('readIndexForQuery 埋点', () => {
  it('getIndex 走读穿缓存：miss → hit，file 指向 workunits/index.json', async () => {
    writeJson('workunits/index.json', []);

    await store.getIndex();
    await store.getIndex();

    const idxEvents = events.filter(e => e.op === 'readIndexForQuery');
    expect(idxEvents.length).toBeGreaterThanOrEqual(2);
    expect(idxEvents[0].file).toBe(path.join(tmpDir, 'workunits', 'index.json'));
    expect(idxEvents[0].cacheHit).toBe(false);
    expect(idxEvents[0].readParseMs).toBeGreaterThanOrEqual(0);
    expect(idxEvents[1].cacheHit).toBe(true);
  });
});

describe('readdir 埋点', () => {
  it('listProfiles 走 readdirCached：miss → hit', async () => {
    writeJson('agents/p1/profile.json', { id: 'p1', status: 'active' });

    await store.listProfiles();
    await store.listProfiles();

    const dirEvents = events.filter(e => e.op === 'readdir');
    expect(dirEvents.length).toBeGreaterThanOrEqual(2);
    expect(dirEvents[0].file).toBe(path.join(tmpDir, 'agents'));
    expect(dirEvents[0].cacheHit).toBe(false);
    expect(dirEvents[0].readParseMs).toBeGreaterThan(0);
    expect(dirEvents[1].cacheHit).toBe(true);
    // readdir 命中不克隆（Dirent[] 直返），cloneMs 恒 0
    expect(dirEvents[1].cloneMs).toBe(0);
  });
});

describe('ALS 循环归因', () => {
  it('runWithLoopLabel 包裹的读带上 label；无 label → unlabeled', async () => {
    const file = writeJson('x.json', { a: 1 });

    await runWithLoopLabel('monitor-round', () => store.readJson(file));
    await store.readJson(file);

    expect(events[0].loop).toBe('monitor-round');
    expect(events[1].loop).toBe('unlabeled');
  });

  it('嵌套 label：内层覆盖、退出后恢复外层', async () => {
    const file = writeJson('x.json', { a: 1 });

    await runWithLoopLabel('outer', async () => {
      await store.readJson(file);
      await runWithLoopLabel('inner', () => store.readJson(file));
      await store.readJson(file);
    });

    expect(events.map(e => e.loop)).toEqual(['outer', 'inner', 'outer']);
  });

  it('并发轮次不串 label', async () => {
    const file = writeJson('x.json', { a: 1 });
    const tick = () => new Promise(r => setTimeout(r, 5));

    await Promise.all([
      runWithLoopLabel('loop-a', async () => {
        await store.readJson(file);
        await tick();
        await store.readJson(file);
      }),
      runWithLoopLabel('loop-b', async () => {
        await store.readJson(file);
        await tick();
        await store.readJson(file);
      }),
    ]);

    expect(events.filter(e => e.loop === 'loop-a')).toHaveLength(2);
    expect(events.filter(e => e.loop === 'loop-b')).toHaveLength(2);
    expect(events.filter(e => e.loop === 'unlabeled')).toHaveLength(0);
  });
});

describe('sink 关闭（默认 null）', () => {
  it('读口行为不变：hit/miss 语义与返回值一致', async () => {
    setReadMetricsSink(null);
    const file = writeJson('x.json', { a: 1 });

    expect(await store.readJson(file)).toEqual({ a: 1 });
    expect(await store.readJson(file)).toEqual({ a: 1 });
    expect(await store.readJson(path.join(tmpDir, 'missing.json'))).toBeNull();
    expect(await store.readJsonl(path.join(tmpDir, 'missing.jsonl'))).toEqual([]);
    expect(await store.getIndex()).toEqual([]);
    expect(events).toHaveLength(0);
  });
});
