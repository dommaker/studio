/**
 * monitor-alerts — 告警分发 / Triage 升级 / 事件写入（D18: 统一事件文件）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const { tmpHome, tmpEvents, eventsFile, mockLogger, mockRecordPattern, mockHandleAlert } = vi.hoisted(() => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const tmpEvents = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-alerts-events-'));
  const eventsFile = path.join(tmpEvents, 'studio-events.jsonl');
  // D18: 统一事件文件按测试文件隔离（resolveStudioEventsFile 懒读 env）
  process.env.STUDIO_EVENTS_FILE = eventsFile;
  return {
    tmpHome: fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-alerts-home-')),
    tmpEvents,
    eventsFile,
    mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    mockRecordPattern: vi.fn(() => Promise.resolve()),
    mockHandleAlert: vi.fn(() => Promise.resolve()),
  };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome };
});

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return { ...actual, logger: mockLogger };
});

vi.mock('../../knowledge/knowledge-service.js', () => ({
  knowledgeService: { recordPattern: mockRecordPattern },
}));

vi.mock('../triage/triage.service.js', () => ({
  triageService: { handleAlert: mockHandleAlert },
}));

const { mockNotifyAlert } = vi.hoisted(() => ({
  mockNotifyAlert: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../../utils/notifier.js', () => ({
  notifyAlert: mockNotifyAlert,
}));

import {
  studioEventsJsonl,
  emitMonitorEvent,
  dispatchMonitorAlerts,
  escalateToTriage,
  recordAlertPatterns,
} from '../monitor/monitor-alerts.js';

function readEventLines(): any[] {
  if (!fs.existsSync(eventsFile)) return [];
  return fs.readFileSync(eventsFile, 'utf-8')
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

  it('does NOT escalate warning alerts', () => {
    escalateToTriage([{ source: 'failure_trend', level: 'warning', message: 'm' } as any]);
    expect(mockHandleAlert).not.toHaveBeenCalled();
  });

  it('does NOT escalate sources mapped to null (tool_error_rate / session_file_size)', () => {
    escalateToTriage([
      { source: 'tool_error_rate', level: 'critical', message: 'a' } as any,
      { source: 'session_file_size', level: 'critical', message: 'c' } as any,
    ]);
    expect(mockHandleAlert).not.toHaveBeenCalled();
  });
});

describe('monitor-alerts: dispatchMonitorAlerts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (fs.existsSync(eventsFile)) fs.unlinkSync(eventsFile);
  });

  it('logs by level and emits only warning/critical to 统一事件文件', async () => {
    dispatchMonitorAlerts([
      { source: 'total_time', level: 'critical', message: 'crit' } as any,
      { source: 'failure_trend', level: 'warning', message: 'warn' } as any,
      { source: 'progress_stagnation', level: 'info', message: 'info' } as any,
    ]);

    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).toHaveBeenCalledTimes(1);

    // emitMonitorEvent 是 fire-and-forget —— 等待落盘
    await vi.waitFor(() => {
      expect(readEventLines()).toHaveLength(2);
    });
    const lines = readEventLines();
    for (const line of lines) {
      expect(line.type).toBe('monitor:alert');
      // D18: StudioEvent 形态 —— 告警字段在 payload 内
      const payload = JSON.parse(line.payload);
      expect(['critical', 'warning']).toContain(payload.level);
      expect(line.source).toBe('monitor');
      expect(line.createdAt).toBeTruthy();
    }
  });

  it('emits nothing for info-only alerts', async () => {
    dispatchMonitorAlerts([{ source: 'progress_stagnation', level: 'info', message: 'i' } as any]);
    await new Promise(r => setTimeout(r, 50));
    expect(readEventLines()).toHaveLength(0);
  });

  it('P0 修复 4: warning/critical 触发 notifyAlert 通知出口，info 不触发', () => {
    dispatchMonitorAlerts([
      { source: 'total_time', level: 'critical', message: 'crit-msg' } as any,
      { source: 'failure_trend', level: 'warning', message: 'warn-msg' } as any,
      { source: 'progress_stagnation', level: 'info', message: 'info-msg' } as any,
    ]);

    expect(mockNotifyAlert).toHaveBeenCalledTimes(2);
    expect(mockNotifyAlert).toHaveBeenCalledWith('critical', '[Monitor] total_time', 'crit-msg');
    expect(mockNotifyAlert).toHaveBeenCalledWith('warning', '[Monitor] failure_trend', 'warn-msg');
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

describe('monitor-alerts: studioEventsJsonl / emitMonitorEvent', () => {
  it('resolves 统一事件文件（STUDIO_EVENTS_FILE 可覆盖）并写入事件', async () => {
    expect(studioEventsJsonl()).toBe(eventsFile);
    emitMonitorEvent({ type: 'monitor:test', marker: 'abc' });
    await vi.waitFor(() => {
      const lines = readEventLines();
      expect(lines.some(l => l.type === 'monitor:test'
        && JSON.parse(l.payload).marker === 'abc')).toBe(true);
    });
  });
});
