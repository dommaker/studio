/**
 * auditor-reports — 洞察与报告输出单元测试
 * analyzeSessionTrends / trackTrends / postToSystemChannel
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const { tmpHome, tmpEvents, eventsFile, mockSave, origHomedir } = vi.hoisted(() => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const tmpEvents = fs.mkdtempSync(path.join(os.tmpdir(), 'auditor-reports-events-'));
  const eventsFile = path.join(tmpEvents, 'studio-events.jsonl');
  // D18: 统一事件文件按测试文件隔离（resolveStudioEventsFile 懒读 env）
  process.env.STUDIO_EVENTS_FILE = eventsFile;
  // homedir 直接补丁：vi.mock 对内建模块在本 vitest 4.1.10 环境不生效（2026-07-28 实测），
  // 经 require 补丁 module.exports 才能让 FileStore 默认目录落进 tmpHome
  const orig = os.homedir;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'auditor-reports-home-'));
  os.homedir = () => tmpHome;
  return {
    tmpHome,
    tmpEvents,
    eventsFile,
    mockSave: vi.fn(),
    origHomedir: orig,
  };
});

vi.mock('../../knowledge/knowledge-bus.service.js', () => ({
  sharedStore: { save: mockSave, list: vi.fn(() => []) },
}));

import { FileStore } from '@dommaker/studio-shared';
import {
  analyzeSessionTrends,
  trackTrends,
  postToSystemChannel,
} from '../auditor/auditor-reports.js';

// 还原 homedir 补丁 + 清理 tmpHome（同 worker 后续文件不受影响）
afterAll(() => {
  const os = require('node:os');
  os.homedir = origHomedir;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const snapshotFile = path.join(tmpHome, '.studio', 'auditor', 'daily-snapshots.jsonl');

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
  // D18: 历史扁平形态（字段在顶层）写入统一事件文件 —— 读方需兼容
  const jsonl = events.map(e => JSON.stringify({
    source: 'test', ...e,
  })).join('\n');
  fs.writeFileSync(eventsFile, jsonl + '\n', 'utf-8');
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
    try { fs.unlinkSync(eventsFile); } catch {}
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

  it('D18: 兼容 StudioEvent 新形态（payload 嵌套 + createdAt + eventCount）', async () => {
    const jsonl = [
      JSON.stringify({
        type: 'session:summary', source: 'claude',
        payload: JSON.stringify({ sessionId: 's1', agentId: 'claude', filesChanged: [], toolsUsed: ['Bash'], patternType: 'ci_fix', eventCount: 20, durationMs: 60000 }),
        createdAt: new Date().toISOString(),
      }),
      JSON.stringify({
        type: 'session:summary', source: 'claude',
        payload: JSON.stringify({ sessionId: 's2', agentId: 'claude', filesChanged: [], toolsUsed: [], patternType: 'unknown', eventCount: 40 }),
        createdAt: new Date().toISOString(),
      }),
    ].join('\n');
    fs.writeFileSync(eventsFile, jsonl + '\n', 'utf-8');

    const insights = await analyzeSessionTrends(since);
    expect(insights[0]).toContain('开发会话: 2 次');
    // eventCount 映射为 turns：平均 (20+40)/2 = 30 —— 不触发 >30 偏高告警
    expect(insights.join('\n')).not.toContain('平均会话');
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
