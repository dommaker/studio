/**
 * monitor-reports — 轨迹评估 / 每日洞察 / 交互模式观察
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const {
  tmpHome, tmpEvents, mockLogger, mockUpdatePref, mockExecSync,
} = vi.hoisted(() => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  return {
    tmpHome: fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-reports-home-')),
    tmpEvents: fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-reports-events-')),
    mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    mockUpdatePref: vi.fn(() => Promise.resolve()),
    mockExecSync: vi.fn(() => '0'),
  };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome };
});

vi.mock('child_process', () => ({ execSync: mockExecSync }));

vi.mock('@dommaker/studio-shared', () => ({
  logger: mockLogger,
  resolveEventsDir: () => tmpEvents,
}));

vi.mock('../../knowledge/knowledge-service.js', () => ({
  knowledgeService: { getStats: () => ({ total: 5, pattern: 2, fix: 1 }) },
}));

vi.mock('../../knowledge/preference-observer.js', () => ({
  preferenceObserver: { updateFromPatternReport: mockUpdatePref },
}));

vi.mock('../../knowledge/knowledge-bus.service.js', () => ({
  sharedStore: { list: vi.fn(() => []) },
}));

vi.mock('../triage-agent.service.js', () => ({
  triageAgent: { handleAlert: vi.fn(() => Promise.resolve()) },
}));

vi.mock('@dommaker/harness', () => ({
  KnowledgeAudit: class { run() { return { totalEntries: 0 }; } },
  FileKnowledgeStore: class { snapshot() {} },
}));

import { evaluateTrajectory, dailyReflection } from '../monitor-reports.js';

function eventsFile(): string {
  return path.join(tmpEvents, 'studio.jsonl');
}

function readEventLines(): any[] {
  if (!fs.existsSync(eventsFile())) return [];
  return fs.readFileSync(eventsFile(), 'utf-8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l));
}

function makeFileStore(overrides: Record<string, unknown> = {}): any {
  return {
    getIndex: vi.fn(async () => []),
    readJsonl: vi.fn(async () => []),
    appendJsonl: vi.fn(async () => {}),
    listChannels: vi.fn(async () => []),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  if (fs.existsSync(eventsFile())) fs.unlinkSync(eventsFile());
});

describe('evaluateTrajectory (G4)', () => {
  const mkWu = (id: string, status: string, durationMin: number, retryCount = 0) => ({
    id, status, retryCount,
    claimedAt: new Date(Date.now() - (durationMin + 1) * 60_000).toISOString(),
    completedAt: new Date(Date.now() - 60_000).toISOString(),
    createdAt: new Date(Date.now() - (durationMin + 5) * 60_000).toISOString(),
    updatedAt: new Date().toISOString(),
  });

  it('computes efficiency/slowRate and emits monitor:trajectory (+ alert when slowRate > 30)', async () => {
    const fileStore = makeFileStore({
      getIndex: vi.fn(async () => [
        mkWu('wu-fast', 'done', 3),    // efficient
        mkWu('wu-norm', 'done', 10),   // normal
        mkWu('wu-slow', 'closed', 20, 2), // slow + retry + failure
      ]),
    });

    await evaluateTrajectory(fileStore);

    const lines = readEventLines();
    const report = lines.find(l => l.type === 'monitor:trajectory');
    expect(report).toBeDefined();
    expect(report).toMatchObject({
      totalWorkUnits: 3,
      efficiency: '67%',  // (1 efficient + 1 normal) / 3 timed
      slowRate: '33%',
      retryCount: 1,
      failureCount: 1,
      verdict: 'good',
    });

    const alert = lines.find(l => l.type === 'monitor:alert' && l.source === 'trajectory');
    expect(alert).toBeDefined();
    expect(alert.level).toBe('warning');
    expect(alert.message).toContain('67%');
  });

  it('does nothing when no recent completed workUnits', async () => {
    await evaluateTrajectory(makeFileStore());
    expect(readEventLines()).toHaveLength(0);
  });
});

describe('dailyReflection', () => {
  it('skips when last run was < 24h ago (GAP-15 gate)', async () => {
    const fileStore = makeFileStore();
    const state = { lastDailyReflectionTs: Date.now() };

    await dailyReflection(fileStore, state);

    expect(fileStore.appendJsonl).not.toHaveBeenCalled();
    expect(fileStore.readJsonl).not.toHaveBeenCalled();
  });

  it('runs on fresh state: aggregates sources and records daily_reflection event', async () => {
    const fileStore = makeFileStore();
    const state = { lastDailyReflectionTs: 0 };

    await dailyReflection(fileStore, state);

    expect(state.lastDailyReflectionTs).toBeGreaterThan(0);
    expect(fileStore.appendJsonl).toHaveBeenCalledWith(
      expect.stringContaining('studio.jsonl'),
      expect.objectContaining({ type: 'daily_reflection', source: 'monitor' }),
    );
    // listChannels → [] → 不发频道卡片；DISCORD_DAILY_CHANNEL 未设置 → 不发 Discord
    expect(fileStore.listChannels).toHaveBeenCalledWith({ name: '#系统' });
  });
});
