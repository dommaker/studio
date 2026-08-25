/**
 * #323 阶段一：sink 关闭零开销断言（计划 §测试第一条）。
 *
 * 模块 mock 掉 read-metrics 的埋点入口：readMetricsBegin 返回 null（= sink 关闭行为），
 * 断言 FileStore 四个读口全程只调 readMetricsBegin（一次 if 检查），
 * 从不调用 emitReadMetric（测量路径不触发）。模块 mock 为文件级，故独立于
 * read-metrics.test.ts。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const { beginSpy, emitSpy } = vi.hoisted(() => ({
  beginSpy: vi.fn((): null => null),
  emitSpy: vi.fn(),
}));

vi.mock('../read-metrics', () => ({
  readMetricsBegin: beginSpy,
  emitReadMetric: emitSpy,
  setReadMetricsSink: vi.fn(),
  runWithLoopLabel: (_label: string, fn: () => unknown) => fn(),
}));

import { FileStore } from '../file-store';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-metrics-off-'));
  beginSpy.mockClear();
  emitSpy.mockClear();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('sink 关闭时零测量路径调用', () => {
  it('readJson / readJsonl / readIndexForQuery / readdir 各只做 begin 检查，不 emit', async () => {
    const store = new FileStore(tmpDir);
    const jsonFile = path.join(tmpDir, 'x.json');
    fs.writeFileSync(jsonFile, JSON.stringify({ a: 1 }));
    const jsonlFile = path.join(tmpDir, 'x.jsonl');
    fs.writeFileSync(jsonlFile, '{"a":1}\n');
    fs.mkdirSync(path.join(tmpDir, 'workunits'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'workunits', 'index.json'), '[]');

    await store.readJson(jsonFile);       // miss
    await store.readJson(jsonFile);       // hit
    await store.readJsonl(jsonlFile);     // miss
    await store.readJsonl(jsonlFile);     // hit
    await store.getIndex();               // readIndexForQuery miss
    await store.getIndex();               // hit
    await store.listProfiles();           // readdir miss
    await store.listProfiles();           // hit

    // 每次读口调用恰好一次 begin 检查（零开销路径的唯一动作）
    expect(beginSpy).toHaveBeenCalledTimes(8);
    // 测量路径从不触发
    expect(emitSpy).not.toHaveBeenCalled();
  });
});
