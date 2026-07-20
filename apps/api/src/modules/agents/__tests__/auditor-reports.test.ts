/**
 * auditor-reports — 洞察与报告输出单元测试
 * analyzeSessionTrends / trackTrends / saveTierStats / postToSystemChannel
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const { tmpHome, tmpEvents, mockSave } = vi.hoisted(() => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  return {
    tmpHome: fs.mkdtempSync(path.join(os.tmpdir(), 'auditor-reports-home-')),
    tmpEvents: fs.mkdtempSync(path.join(os.tmpdir(), 'auditor-reports-events-')),
    mockSave: vi.fn(),
  };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome };
});

vi.mock('../../knowledge/knowledge-bus.service.js', () => ({
  sharedStore: { save: mockSave, list: vi.fn(() => []) },
}));

import { FileStore } from '@dommaker/studio-shared';
import {
  analyzeSessionTrends,
  trackTrends,
  saveTierStats,
  postToSystemChannel,
} from '../auditor-reports.js';

const snapshotFile = path.join(tmpHome, '.studio', 'auditor', 'daily-snapshots.jsonl');

const prevEventsDir = process.env.STUDIO_EVENTS_DIR;

beforeAll(() => {
  process.env.STUDIO_EVENTS_DIR = tmpEvents;
});

afterAll(() => {
  if (prevEventsDir === undefined) delete process.env.STUDIO_EVENTS_DIR;
  else process.env.STUDIO_EVENTS_DIR = prevEventsDir;
});

function makeSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    date: '2026-07-10',
    totalSessions: 5,
    deepAnalysisCount: 3,
    missingCaptureCount: 1,
    sensitiveOpsSessions: 0,
    highSensitiveOpsCount: 0,
    avgTurns: 15,
    maxTurnCount: 25,
    ...overrides,
  };
}

function writeSessionEvents(events: Array<Record<string, unknown>>): void {
  const jsonl = events.map(e => JSON.stringify({
    source: 'test', payload: '{}', ...e,
  })).join('\n');
  fs.writeFileSync(path.join(tmpEvents, 'studio.jsonl'), jsonl + '\n', 'utf-8');
}

// ── trackTrends ──

describe('trackTrends()', () => {
  beforeEach(() => {
    try { fs.unlinkSync(snapshotFile); } catch {}
  });

  it('saves daily snapshot to JSONL file', () => {
    trackTrends(makeSnapshot({ date: '2026-07-10' }));
    const content = fs.readFileSync(snapshotFile, 'utf-8');
    expect(content).toContain('2026-07-10');
    expect(content).toContain('"totalSessions":5');
  });

  it('deduplicates snapshots by date', () => {
    trackTrends(makeSnapshot({ date: '2026-07-10', totalSessions: 1 }));
    trackTrends(makeSnapshot({ date: '2026-07-10', totalSessions: 9 }));
    const entries = fs.readFileSync(snapshotFile, 'utf-8').split('\n').filter(Boolean);
    expect(entries.length).toBe(1);
    expect(entries[0]).toContain('"totalSessions":9');
  });

  it('returns empty when < 3 days of history', () => {
    trackTrends(makeSnapshot({ date: '2026-07-08' }));
    const result = trackTrends(makeSnapshot({ date: '2026-07-09' }));
    expect(result).toEqual([]);
  });

  it('detects sensitive ops increasing vs 7-day average', () => {
    const lines: string[] = [];
    for (let i = 7; i >= 1; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      lines.push(JSON.stringify(makeSnapshot({ date: d, sensitiveOpsSessions: 1 })));
    }
    fs.mkdirSync(path.dirname(snapshotFile), { recursive: true });
    fs.writeFileSync(snapshotFile, lines.join('\n') + '\n', 'utf-8');

    const today = new Date().toISOString().slice(0, 10);
    const result = trackTrends(makeSnapshot({ date: today, sensitiveOpsSessions: 4 }));
    expect(result.some(r => r.includes('敏感操作'))).toBe(true);
  });

  it('keeps only last 30 days of snapshots', () => {
    const lines: string[] = [];
    for (let i = 35; i >= 1; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      lines.push(JSON.stringify(makeSnapshot({ date: d })));
    }
    fs.mkdirSync(path.dirname(snapshotFile), { recursive: true });
    fs.writeFileSync(snapshotFile, lines.join('\n') + '\n', 'utf-8');

    const today = new Date().toISOString().slice(0, 10);
    trackTrends(makeSnapshot({ date: today }));

    const entries = fs.readFileSync(snapshotFile, 'utf-8').split('\n').filter(Boolean);
    expect(entries.length).toBeLessThanOrEqual(31); // 30 historical + today
  });
});

// ── analyzeSessionTrends ──

describe('analyzeSessionTrends()', () => {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  beforeEach(() => {
    try { fs.unlinkSync(path.join(tmpEvents, 'studio.jsonl')); } catch {}
    try { fs.unlinkSync(snapshotFile); } catch {}
  });

  it('returns empty when events file missing', async () => {
    expect(await analyzeSessionTrends(since)).toEqual([]);
  });

  it('returns empty when no recent session:summary events', async () => {
    writeSessionEvents([
      { type: 'session:summary', timestamp: new Date(Date.now() - 48 * 3600_000).toISOString(), turnCount: 10 },
      { type: 'other:event', timestamp: new Date().toISOString() },
    ]);
    expect(await analyzeSessionTrends(since)).toEqual([]);
  });

  it('aggregates session metrics and capture rate', async () => {
    writeSessionEvents([
      { type: 'session:summary', timestamp: new Date().toISOString(), deepAnalysis: true, knowledgeCaptured: true, turnCount: 10 },
      { type: 'session:summary', timestamp: new Date().toISOString(), deepAnalysis: false, turnCount: 12 },
    ]);

    const insights = await analyzeSessionTrends(since);
    expect(insights[0]).toContain('开发会话: 2 次');
    expect(insights[0]).toContain('深度分析: 1');
    expect(insights[0]).toContain('知识捕获率: 100%');
  });

  it('flags sensitive ops, capture degradation and long sessions', async () => {
    writeSessionEvents([
      { type: 'session:summary', timestamp: new Date().toISOString(), deepAnalysis: true, knowledgeCaptured: false, sensitiveOpsCount: 3, turnCount: 60 },
      { type: 'session:summary', timestamp: new Date().toISOString(), deepAnalysis: true, knowledgeCaptured: false, sensitiveOpsCount: 4, turnCount: 55 },
      { type: 'session:summary', timestamp: new Date().toISOString(), deepAnalysis: true, knowledgeCaptured: false, sensitiveOpsCount: 0, turnCount: 70 },
    ]);

    const insights = await analyzeSessionTrends(since);
    const joined = insights.join('\n');

    // 2/3 会话有敏感操作，且 2 个会话高频 (>=3 次)
    expect(joined).toContain('2/3 会话有未验证敏感操作 (67%)');
    expect(joined).toContain('多个会话高频触发敏感操作检测');
    // 3/3 深度分析无产出 → 捕获率 < 50%
    expect(joined).toContain('知识捕获率 < 50% (3/3');
    // 最长会话 70 > 50 turns；平均 62 > 30
    expect(joined).toContain('最长会话 70 turns');
    expect(joined).toContain('平均会话 62 turns');
  });
});

// ── saveTierStats ──

describe('saveTierStats()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does nothing for empty tier stats', async () => {
    await saveTierStats(new Map());
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('saves tier success rates to knowledge bus', async () => {
    const tierStats = new Map([
      ['standard', { total: 10, failed: 2 }],
      ['fast', { total: 0, failed: 0 }],
    ]);
    await saveTierStats(tierStats);

    expect(mockSave).toHaveBeenCalledTimes(1);
    const entry = mockSave.mock.calls[0][0];
    expect(entry.id).toMatch(/^tier-stats-\d{4}-\d{2}-\d{2}$/);
    expect(entry.title).toBe('tier_success_rate');
    expect(entry.tags).toEqual(['audit', 'tier_stats']);
    expect(entry.contributors).toEqual(['auditor-agent']);

    const stats = JSON.parse(entry.content);
    expect(stats).toEqual([
      { tier: 'standard', total: 10, failed: 2, successRate: 80 },
      { tier: 'fast', total: 0, failed: 0, successRate: 100 },
    ]);
  });
});

// ── postToSystemChannel ──

describe('postToSystemChannel()', () => {
  it('resolves without posting when #系统 channel not found', async () => {
    const emptyStore = new FileStore(path.join(tmpHome, 'empty-data'));
    await expect(postToSystemChannel(emptyStore, 'content')).resolves.toBeUndefined();
  });

  it('posts audit report card to #系统 channel', async () => {
    const fileStore = new FileStore(); // default baseDir → mocked homedir
    const channelId = `sys-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await fileStore.createChannel({
      id: channelId,
      name: '#系统',
      type: 'system',
      defaultWorkspaceId: null,
      defaultPath: null,
      discordChannelId: null,
      discordWebhookUrl: null,
      members: '[]',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    // Clean up stale #系统 channels from other runs
    for (const stale of await fileStore.listChannels({ name: '#系统' })) {
      if (stale.id !== channelId) await fileStore.deleteChannel(stale.id).catch(() => {});
    }

    await postToSystemChannel(fileStore, '测试审计报告内容');

    const msgs = await fileStore.queryAllMessages({ agentNames: ['Auditor'] });
    const card = msgs.find(m => m.channelId === channelId && m.content.includes('测试审计报告内容'));
    expect(card).toBeDefined();
    const meta = typeof card!.meta === 'string' ? JSON.parse(card!.meta) : (card!.meta ?? {});
    expect(meta.cardType).toBe('audit-report');
    expect(meta.source).toBe('auditor-agent');
  });
});
