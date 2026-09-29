/**
 * monitor-lifecycle — G31 知识沉淀闸门 + 数据 TTL 清理
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const { tmpHome, tmpEvents, eventsFile, mockLogger, mockUnlinkSync } = vi.hoisted(() => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const tmpEvents = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-lifecycle-events-'));
  const eventsFile = path.join(tmpEvents, 'studio-events.jsonl');
  // D18: 统一事件文件按测试文件隔离（resolveStudioEventsFile 懒读 env）
  process.env.STUDIO_EVENTS_FILE = eventsFile;
  return {
    tmpHome: fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-lifecycle-home-')),
    tmpEvents,
    eventsFile,
    mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    mockUnlinkSync: vi.fn(),
  };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome };
});

// 显式清理：hoisted 里的 require('fs') 走原生模块，mkdtemp-cleanup 补丁登记不到
afterAll(() => {
  for (const d of [tmpHome, tmpEvents]) fs.rmSync(d, { recursive: true, force: true });
});

// unlinkSync 置为 no-op：dataLifecycle 会清理 process.cwd()/.harness/logs 下真实 traces 备份，
// 测试中绝不能真删仓库文件
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, unlinkSync: mockUnlinkSync };
});

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return { ...actual, logger: mockLogger };
});

vi.mock('../../knowledge/knowledge-service.js', () => ({ knowledgeService: {} }));
vi.mock('../triage/triage.service.js', () => ({ triageService: { handleAlert: vi.fn(() => Promise.resolve()) } }));

import { precipitate, dataLifecycle } from '../monitor/monitor-lifecycle.js';

function makeFileStore(overrides: Record<string, unknown> = {}): any {
  return {
    getIndex: vi.fn(async () => []),
    readJson: vi.fn(async () => null),
    readJsonl: vi.fn(async () => []),
    removeSnapshot: vi.fn(async () => {}),
    // #170：删除走锁内墓碑 + 移除成对原语
    commitRemoval: vi.fn(async () => {}),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fs.rmSync(eventsFile, { force: true }); // rmSync 未被 mock，真实清理事件文件
});

afterEach(() => {
  vi.useRealTimers();
});

describe('precipitate (G31 沉淀闸门)', () => {
  it('sessions 闸门照常执行；studio-events 打标已随 #653 解除（闸门不再触碰事件文件）', async () => {
    const state = { lastPrecipitateRun: '', lastDataLifecycleRun: '' };

    const gate = await precipitate(state);

    expect(gate).toEqual({ sessions: true });
    expect(state.lastPrecipitateRun).not.toBe('');
    expect(fs.existsSync(eventsFile)).toBe(false); // 不再读/重写 studio-events.jsonl
  });

  it('second call on the same day is a no-op (returns empty results)', async () => {
    const state = { lastPrecipitateRun: '', lastDataLifecycleRun: '' };

    const first = await precipitate(state);
    expect(first).not.toEqual({});

    const again = await precipitate(state);
    expect(again).toEqual({});
  });
});

describe('dataLifecycle (每日 23:55 TTL)', () => {
  it('returns early outside the 23:50-23:59 window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 19, 10, 0)); // 本地 10:00
    const fileStore = makeFileStore();
    const state = { lastPrecipitateRun: '', lastDataLifecycleRun: '' };

    await dataLifecycle(fileStore, state);

    expect(state.lastDataLifecycleRun).toBe('');
    expect(fileStore.getIndex).not.toHaveBeenCalled();
  });

  it('in window: runs precipitation gate + deletes terminal WorkUnits older than 90 days, once per day', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 19, 23, 55)); // 本地 23:55
    // #540：仅终态（done/closed）才进 TTL 删除；进行中/阻塞单满 90 天保留
    const oldWu = { id: 'wu-old', status: 'done', createdAt: new Date(Date.now() - 100 * 24 * 3600_000).toISOString() };
    const newWu = { id: 'wu-new', status: 'active', createdAt: new Date().toISOString() };
    const fileStore = makeFileStore({ getIndex: vi.fn(async () => [oldWu, newWu]) });
    const state = { lastPrecipitateRun: '', lastDataLifecycleRun: '' };

    await dataLifecycle(fileStore, state);

    expect(state.lastDataLifecycleRun).not.toBe('');
    expect(state.lastPrecipitateRun).not.toBe(''); // 闸门先于清理执行
    // #538（ADR 2026-09-15 决策 3）：删除循环改调 service.delete(id, { reason })——
    // 墓碑事件行由 service 单点构造（closed + deleted:true + reason），调用方不自拼
    expect(fileStore.commitRemoval).toHaveBeenCalledTimes(1);
    expect(fileStore.commitRemoval).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'closed',
        wuId: 'wu-old',
        data: expect.objectContaining({ deleted: true, reason: expect.stringContaining('90 days') }),
      }),
      'wu-old',
    );

    // 同一天第二次调用直接去重返回
    await dataLifecycle(fileStore, state);
    expect(fileStore.commitRemoval).toHaveBeenCalledTimes(1);
  });

  it('满 90 天的非终态单（active/blocked/in_review/pending/unassigned/无 status）不删，仅终态（done/closed）删（#540）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 19, 23, 55));
    const old = () => new Date(Date.now() - 100 * 24 * 3600_000).toISOString();
    const fileStore = makeFileStore({
      getIndex: vi.fn(async () => [
        { id: 'wu-done', status: 'done', createdAt: old() },
        { id: 'wu-closed', status: 'closed', createdAt: old() },
        { id: 'wu-active', status: 'active', createdAt: old() },
        { id: 'wu-blocked', status: 'blocked', createdAt: old() },
        { id: 'wu-review', status: 'in_review', createdAt: old() },
        { id: 'wu-pending', status: 'pending', createdAt: old() },
        { id: 'wu-unassigned', status: 'unassigned', createdAt: old() },
        { id: 'wu-nostatus', createdAt: old() }, // 缺 status 按非终态保留（不误删）
      ]),
    });
    const state = { lastPrecipitateRun: '', lastDataLifecycleRun: '' };

    await dataLifecycle(fileStore, state);

    expect(fileStore.commitRemoval).toHaveBeenCalledTimes(2);
    const deletedIds = fileStore.commitRemoval.mock.calls.map((c: [unknown, string]) => c[1]);
    expect(deletedIds.sort()).toEqual(['wu-closed', 'wu-done']);
  });

  it('#653：窗口内不再触碰 studio-events.jsonl —— >7d/>30d 事件自然存活，保留执法归 #173 轮转', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 19, 23, 55));
    const fileStore = makeFileStore();
    const state = { lastPrecipitateRun: '', lastDataLifecycleRun: '' };

    const lines = [
      JSON.stringify({ type: 'old-8d', createdAt: new Date(Date.now() - 8 * 24 * 3600_000).toISOString(), precipitated: true }),
      JSON.stringify({ type: 'old-35d', createdAt: new Date(Date.now() - 35 * 24 * 3600_000).toISOString(), precipitated: true }),
      JSON.stringify({ type: 'recent', createdAt: new Date().toISOString() }),
      '{broken',
    ];
    const original = lines.join('\n') + '\n';
    fs.writeFileSync(eventsFile, original, 'utf-8');

    await dataLifecycle(fileStore, state);

    expect(fs.readFileSync(eventsFile, 'utf-8')).toBe(original); // 字节级不变
  });
});
