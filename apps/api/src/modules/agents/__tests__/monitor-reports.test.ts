/**
 * monitor-reports — 轨迹评估 / 每日洞察 / 交互模式观察（D18: 统一事件文件）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const {
  tmpHome, tmpEvents, eventsFile, mockLogger, mockUpdatePref, mockExecSync,
} = vi.hoisted(() => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const tmpEvents = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-reports-events-'));
  const eventsFile = path.join(tmpEvents, 'studio-events.jsonl');
  // D18: 统一事件文件按测试文件隔离（resolveStudioEventsFile 懒读 env）
  process.env.STUDIO_EVENTS_FILE = eventsFile;
  return {
    tmpHome: fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-reports-home-')),
    tmpEvents,
    eventsFile,
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

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return { ...actual, logger: mockLogger };
});

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

vi.mock('@dommaker/harness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/harness')>();
  return {
    ...actual,
    KnowledgeAudit: class { run() { return { totalEntries: 0 }; } },
    FileKnowledgeStore: class { snapshot() {} },
  };
});

import { evaluateTrajectory, dailyReflection } from '../monitor-reports.js';

function readEventLines(): any[] {
  if (!fs.existsSync(eventsFile)) return [];
  return fs.readFileSync(eventsFile, 'utf-8')
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
  if (fs.existsSync(eventsFile)) fs.unlinkSync(eventsFile);
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

    // emitMonitorEvent 是 fire-and-forget —— 等待落盘（D18: StudioEvent 形态，字段在 payload）
    let lines: any[] = [];
    await vi.waitFor(() => {
      lines = readEventLines();
      expect(lines.some(l => l.type === 'monitor:alert')).toBe(true);
    });

    const report = lines.find(l => l.type === 'monitor:trajectory');
    expect(report).toBeDefined();
    expect(JSON.parse(report.payload)).toMatchObject({
      totalWorkUnits: 3,
      efficiency: '67%',  // (1 efficient + 1 normal) / 3 timed
      slowRate: '33%',
      retryCount: 1,
      failureCount: 1,
      verdict: 'good',
    });

    const alert = lines.find(l => l.type === 'monitor:alert' && JSON.parse(l.payload).source === 'trajectory');
    expect(alert).toBeDefined();
    const alertPayload = JSON.parse(alert.payload);
    expect(alertPayload.level).toBe('warning');
    expect(alertPayload.message).toContain('67%');
  });

  it('does nothing when no recent completed workUnits', async () => {
    await evaluateTrajectory(makeFileStore());
    await new Promise(r => setTimeout(r, 50));
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
    // D18: daily_reflection 经统一入口落盘（fire-and-forget —— 等待）
    await vi.waitFor(() => {
      const lines = readEventLines();
      const evt = lines.find(l => l.type === 'daily_reflection' && l.source === 'monitor');
      expect(evt).toBeDefined();
    });
    // listChannels → [] → 不发频道卡片；DISCORD_DAILY_CHANNEL 未设置 → 不发 Discord
    expect(fileStore.listChannels).toHaveBeenCalledWith({ name: '#系统' });
  });

  it('读方一致（D18 裂口修复）：session:summary / knowledge:consumption 从统一文件可读', async () => {
    // 会话活动 + 知识消费事件写在统一文件（session-summary-generator 同款 StudioEvent 形态）
    const now = Date.now();
    const rows = [
      {
        type: 'session:summary', source: 'claude',
        payload: JSON.stringify({
          sessionId: 's1', agentId: 'claude', filesChanged: ['a.ts'], toolsUsed: ['Bash'],
          patternType: 'ci_fix', eventCount: 42, durationMs: 600_000,
        }),
        createdAt: new Date(now - 3600_000).toISOString(),
      },
      {
        type: 'knowledge:consumption', source: 'prompt-inject',
        payload: JSON.stringify({ entryId: 'k1', timestamp: new Date(now - 3600_000).toISOString() }),
        createdAt: new Date(now - 3600_000).toISOString(),
      },
    ];
    fs.writeFileSync(eventsFile, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');

    const posted: string[] = [];
    const fileStore = makeFileStore({
      listChannels: vi.fn(async () => [{ id: 'ch-sys', name: '#系统' }]),
    });
    vi.doMock('../../channels/channel-message.service.js', () => ({
      channelMessageService: {
        createAgentMessage: vi.fn(async (_ch: string, _sender: string, content: string) => {
          posted.push(content);
        }),
      },
    }));
    vi.resetModules();
    const { dailyReflection: dr } = await import('../monitor-reports.js');

    await dr(fileStore, { lastDailyReflectionTs: 0 });

    // 频道卡片内容包含会话活动（此前读 studio.jsonl 永远读不到）
    expect(posted.length).toBeGreaterThan(0);
    expect(posted[0]).toContain('会话活动');
    expect(posted[0]).toContain('会话: 1 次');
    expect(posted[0]).toContain('知识消费');
  });
});
