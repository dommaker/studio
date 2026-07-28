/**
 * monitor-lifecycle — G31 知识沉淀闸门 + 数据 TTL 清理
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
vi.mock('../triage.service.js', () => ({ triageService: { handleAlert: vi.fn(() => Promise.resolve()) } }));

import { precipitate, dataLifecycle } from '../monitor-lifecycle.js';

function makeFileStore(overrides: Record<string, unknown> = {}): any {
  return {
    getIndex: vi.fn(async () => []),
    readJson: vi.fn(async () => null),
    readJsonl: vi.fn(async () => []),
    removeSnapshot: vi.fn(async () => {}),
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
  it('marks 7-30d unmarked events as precipitated and reports gate results（兼容 createdAt 与历史 timestamp）', async () => {
    // D18 后新事件用 createdAt；历史扁平事件用 timestamp —— 两种都应被闸门识别
    const old = { type: 'x', timestamp: new Date(Date.now() - 10 * 24 * 3600_000).toISOString(), precipitated: false };
    const oldNewShape = { type: 'z', createdAt: new Date(Date.now() - 10 * 24 * 3600_000).toISOString(), precipitated: false };
    const recent = { type: 'y', createdAt: new Date().toISOString(), precipitated: false };
    const fileStore = makeFileStore({ readJsonl: vi.fn(async () => [old, oldNewShape, recent]) });
    const state = { lastPrecipitateRun: '', lastDataLifecycleRun: '' };

    const gate = await precipitate(fileStore, state);

    expect(gate).toEqual({ studioEvent: true, sessions: true });
    expect(state.lastPrecipitateRun).not.toBe('');
    const written = fs.readFileSync(eventsFile, 'utf-8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
    expect(written.find(e => e.type === 'x').precipitated).toBe(true);
    expect(written.find(e => e.type === 'z').precipitated).toBe(true);
    expect(written.find(e => e.type === 'y').precipitated).toBe(false);
  });

  it('second call on the same day is a no-op (returns empty results)', async () => {
    const fileStore = makeFileStore({ readJsonl: vi.fn(async () => []) });
    const state = { lastPrecipitateRun: '', lastDataLifecycleRun: '' };

    await precipitate(fileStore, state);
    expect(fileStore.readJsonl).toHaveBeenCalledTimes(1);

    const again = await precipitate(fileStore, state);
    expect(again).toEqual({});
    expect(fileStore.readJsonl).toHaveBeenCalledTimes(1);
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

  it('in window: runs precipitation gate + deletes WorkUnits older than 90 days, once per day', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 19, 23, 55)); // 本地 23:55
    const oldWu = { id: 'wu-old', createdAt: new Date(Date.now() - 100 * 24 * 3600_000).toISOString() };
    const newWu = { id: 'wu-new', createdAt: new Date().toISOString() };
    const fileStore = makeFileStore({ getIndex: vi.fn(async () => [oldWu, newWu]) });
    const state = { lastPrecipitateRun: '', lastDataLifecycleRun: '' };

    await dataLifecycle(fileStore, state);

    expect(state.lastDataLifecycleRun).not.toBe('');
    expect(state.lastPrecipitateRun).not.toBe(''); // 闸门先于清理执行
    expect(fileStore.removeSnapshot).toHaveBeenCalledTimes(1);
    expect(fileStore.removeSnapshot).toHaveBeenCalledWith('wu-old');

    // 同一天第二次调用直接去重返回
    await dataLifecycle(fileStore, state);
    expect(fileStore.removeSnapshot).toHaveBeenCalledTimes(1);
  });

  it('truncates 统一事件文件 keeping last 7 days（createdAt 口径，坏行保留）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 19, 23, 55));
    const realRead = async (fp: string) => {
      if (!fs.existsSync(fp)) return [];
      return fs.readFileSync(fp, 'utf-8').split('\n').filter(l => l.trim())
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    };
    const fileStore = makeFileStore({ readJsonl: vi.fn(realRead) });
    const state = { lastPrecipitateRun: '', lastDataLifecycleRun: '' };

    const old8d = { type: 'old', createdAt: new Date(Date.now() - 8 * 24 * 3600_000).toISOString(), precipitated: true };
    const old8dLegacy = { type: 'old-legacy', timestamp: Date.now() - 8 * 24 * 3600_000, precipitated: true };
    const recent = { type: 'recent', createdAt: new Date().toISOString() };
    fs.writeFileSync(eventsFile,
      [JSON.stringify(old8d), JSON.stringify(old8dLegacy), JSON.stringify(recent), '{broken'].join('\n') + '\n', 'utf-8');

    await dataLifecycle(fileStore, state);

    const keptRaw = fs.readFileSync(eventsFile, 'utf-8').split('\n').filter(l => l.trim());
    // 注意：section 7（StudioEvent TTL，>30d 已沉淀）也会再删一轮 —— 8d 未超 30d，只被 section 5 移除；
    // 坏行在 section 5 保留，但 section 7 走 readJsonl 重写会丢弃（既有行为，不在本次改动范围）
    const kept = keptRaw.map(l => { try { return JSON.parse(l); } catch { return null; } });
    expect(kept.some(e => e?.type === 'old')).toBe(false);
    expect(kept.some(e => e?.type === 'old-legacy')).toBe(false);
    expect(kept.some(e => e?.type === 'recent')).toBe(true);
  });

  it('skips StudioEvent cleanup when precipitation failed (gate=false)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 19, 23, 55));
    const fileStore = makeFileStore({ readJsonl: vi.fn(async () => { throw new Error('read fail'); }) });
    const state = { lastPrecipitateRun: '', lastDataLifecycleRun: '' };

    await dataLifecycle(fileStore, state);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      '[MonitorService] TTL: StudioEvent cleanup skipped (precipitation failed)',
    );
  });
});
