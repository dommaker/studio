/**
 * monitor-lifecycle — G31 知识沉淀闸门 + 数据 TTL 清理
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const { tmpHome, tmpEvents, mockLogger, mockUnlinkSync } = vi.hoisted(() => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  return {
    tmpHome: fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-lifecycle-home-')),
    tmpEvents: fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-lifecycle-events-')),
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

vi.mock('@dommaker/studio-shared', () => ({
  logger: mockLogger,
  resolveEventsDir: () => tmpEvents,
}));

vi.mock('../../knowledge/knowledge-service.js', () => ({ knowledgeService: {} }));
vi.mock('../triage-agent.service.js', () => ({ triageAgent: { handleAlert: vi.fn(() => Promise.resolve()) } }));

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

function eventsFile(): string {
  return path.join(tmpEvents, 'studio.jsonl');
}

beforeEach(() => {
  vi.clearAllMocks();
  fs.rmSync(eventsFile(), { force: true }); // rmSync 未被 mock，真实清理事件文件
});

afterEach(() => {
  vi.useRealTimers();
});

describe('precipitate (G31 沉淀闸门)', () => {
  it('marks 7-30d unmarked events as precipitated and reports gate results', async () => {
    const old = { type: 'x', timestamp: new Date(Date.now() - 10 * 24 * 3600_000).toISOString(), precipitated: false };
    const recent = { type: 'y', timestamp: new Date().toISOString(), precipitated: false };
    const fileStore = makeFileStore({ readJsonl: vi.fn(async () => [old, recent]) });
    const state = { lastPrecipitateRun: '', lastDataLifecycleRun: '' };

    const gate = await precipitate(fileStore, state);

    expect(gate).toEqual({ studioEvent: true, sessions: true });
    expect(state.lastPrecipitateRun).not.toBe('');
    const written = fs.readFileSync(eventsFile(), 'utf-8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
    expect(written.find(e => e.type === 'x').precipitated).toBe(true);
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

  it('skips StudioEvent cleanup when precipitation failed (gate=false)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 19, 23, 55));
    const fileStore = makeFileStore({ readJsonl: vi.fn(async () => { throw new Error('read fail'); }) });
    const state = { lastPrecipitateRun: '', lastDataLifecycleRun: '' };

    await dataLifecycle(fileStore, state);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      '[MonitorAgent] TTL: StudioEvent cleanup skipped (precipitation failed)',
    );
  });
});
