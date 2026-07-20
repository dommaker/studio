/**
 * monitor-alerts — 告警分发 / Triage 升级 / 事件写入 / 心跳持久化
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const { tmpHome, tmpEvents, mockLogger, mockRecordPattern, mockHandleAlert } = vi.hoisted(() => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  return {
    tmpHome: fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-alerts-home-')),
    tmpEvents: fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-alerts-events-')),
    mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    mockRecordPattern: vi.fn(() => Promise.resolve()),
    mockHandleAlert: vi.fn(() => Promise.resolve()),
  };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome };
});

vi.mock('@dommaker/studio-shared', () => ({
  logger: mockLogger,
  resolveEventsDir: () => tmpEvents,
}));

vi.mock('../../knowledge/knowledge-service.js', () => ({
  knowledgeService: { recordPattern: mockRecordPattern },
}));

vi.mock('../triage-agent.service.js', () => ({
  triageAgent: { handleAlert: mockHandleAlert },
}));

import {
  studioEventsJsonl,
  emitMonitorEvent,
  dispatchMonitorAlerts,
  escalateToTriage,
  recordAlertPatterns,
  recordHeartbeat,
  loadPersistedHeartbeats,
} from '../monitor-alerts.js';

function readEventLines(): any[] {
  const file = path.join(tmpEvents, 'studio.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l));
}

describe('monitor-alerts: escalateToTriage (FL-037)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('escalates critical failure_trend → execution_repeated_failure', () => {
    escalateToTriage([{
      source: 'failure_trend', level: 'critical', message: '最近 1 小时内有 3 个任务失败',
      projectId: 'p1', relatedTaskIds: ['t1', 't2'],
    } as any]);

    expect(mockHandleAlert).toHaveBeenCalledTimes(1);
    expect(mockHandleAlert).toHaveBeenCalledWith(expect.objectContaining({
      type: 'execution_repeated_failure',
      severity: 'critical',
      message: '最近 1 小时内有 3 个任务失败',
      details: expect.objectContaining({ projectId: 'p1', monitorSource: 'failure_trend' }),
    }));
  });

  it('escalates critical deploy_push_failed → ext_dependency', () => {
    escalateToTriage([{ source: 'deploy_push_failed', level: 'critical', message: 'push failed' } as any]);
    expect(mockHandleAlert).toHaveBeenCalledWith(expect.objectContaining({ type: 'ext_dependency' }));
  });

  it('does NOT escalate warning alerts', () => {
    escalateToTriage([{ source: 'failure_trend', level: 'warning', message: 'm' } as any]);
    expect(mockHandleAlert).not.toHaveBeenCalled();
  });

  it('does NOT escalate sources mapped to null (tool_error_rate / review_quality)', () => {
    escalateToTriage([
      { source: 'tool_error_rate', level: 'critical', message: 'a' } as any,
      { source: 'review_quality', level: 'critical', message: 'b' } as any,
      { source: 'session_file_size', level: 'critical', message: 'c' } as any,
    ]);
    expect(mockHandleAlert).not.toHaveBeenCalled();
  });
});

describe('monitor-alerts: dispatchMonitorAlerts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const f = path.join(tmpEvents, 'studio.jsonl');
    if (fs.existsSync(f)) fs.unlinkSync(f);
  });

  it('logs by level and emits only warning/critical to studio.jsonl', () => {
    dispatchMonitorAlerts([
      { source: 'total_time', level: 'critical', message: 'crit' } as any,
      { source: 'failure_trend', level: 'warning', message: 'warn' } as any,
      { source: 'progress_stagnation', level: 'info', message: 'info' } as any,
    ]);

    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).toHaveBeenCalledTimes(1);

    const lines = readEventLines();
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.type).toBe('monitor:alert');
      expect(['critical', 'warning']).toContain(line.level);
    }
  });

  it('emits nothing for info-only alerts', () => {
    dispatchMonitorAlerts([{ source: 'progress_stagnation', level: 'info', message: 'i' } as any]);
    expect(readEventLines()).toHaveLength(0);
  });
});

describe('monitor-alerts: recordAlertPatterns (H3)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records warning/critical patterns; tool sources typed as failure', () => {
    recordAlertPatterns([
      { source: 'tool_error_rate', level: 'warning', message: 'tool err' } as any,
      { source: 'failure_trend', level: 'critical', message: 'trend' } as any,
      { source: 'progress_stagnation', level: 'info', message: 'skip' } as any,
    ]);

    expect(mockRecordPattern).toHaveBeenCalledTimes(2);
    expect(mockRecordPattern).toHaveBeenCalledWith(expect.objectContaining({
      type: 'failure',
      title: '[Monitor] tool_error_rate: tool err',
      tags: ['monitor'],
    }));
    expect(mockRecordPattern).toHaveBeenCalledWith(expect.objectContaining({
      type: 'pattern',
      title: '[Monitor] failure_trend: trend',
    }));
  });
});

describe('monitor-alerts: heartbeat persistence', () => {
  beforeEach(() => vi.clearAllMocks());

  const hbFile = () => path.join(tmpHome, '.studio', 'heartbeats.json');

  it('recordHeartbeat persists heartbeat to file', () => {
    recordHeartbeat('exec-1');

    expect(fs.existsSync(hbFile())).toBe(true);
    const data = JSON.parse(fs.readFileSync(hbFile(), 'utf-8'));
    expect(typeof data['exec-1']).toBe('number');
  });

  it('loadPersistedHeartbeats restores fresh entries and drops stale (>30min)', () => {
    fs.mkdirSync(path.dirname(hbFile()), { recursive: true });
    fs.writeFileSync(hbFile(), JSON.stringify({
      'stale-exec': Date.now() - 60 * 60_000,
      'fresh-exec': Date.now(),
    }));

    loadPersistedHeartbeats();

    const fresh = JSON.parse(fs.readFileSync(hbFile(), 'utf-8'));
    expect(fresh['stale-exec']).toBeUndefined();
    expect(typeof fresh['fresh-exec']).toBe('number');
    expect(mockLogger.info).toHaveBeenCalledWith('[MonitorAgent] Restored heartbeats', expect.objectContaining({ count: expect.any(Number) }));
  });

  it('loadPersistedHeartbeats is a no-op when file missing', () => {
    if (fs.existsSync(hbFile())) fs.unlinkSync(hbFile());
    loadPersistedHeartbeats();
    expect(mockLogger.info).not.toHaveBeenCalledWith('[MonitorAgent] Restored heartbeats', expect.anything());
  });
});

describe('monitor-alerts: studioEventsJsonl / emitMonitorEvent', () => {
  it('resolves studio.jsonl under events dir and appends events', () => {
    expect(studioEventsJsonl()).toBe(path.join(tmpEvents, 'studio.jsonl'));
    emitMonitorEvent({ type: 'monitor:test', marker: 'abc' });
    const lines = readEventLines();
    expect(lines.some(l => l.type === 'monitor:test' && l.marker === 'abc')).toBe(true);
  });
});
