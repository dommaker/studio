/**
 * AuditorService B13-011 — trackTrends 单元测试
 *
 * 不依赖 Prisma，直接测试 trackTrends 方法的文件读写和趋势检测逻辑。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const snapshotFile = path.join(os.homedir(), '.studio', 'auditor', 'daily-snapshots.jsonl');

// Dynamic import to avoid Prisma initialization at module level
async function getAgent() {
  const { AuditorService } = await import('../auditor.service.js');
  return new AuditorService();
}

function makeSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    date: '2026-05-30',
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

describe('AuditorService.trackTrends (B13-011)', () => {
  let savedContent: string | null = null;

  beforeEach(() => {
    try { savedContent = fs.readFileSync(snapshotFile, 'utf-8'); } catch { savedContent = null; }
  });

  afterEach(() => {
    if (savedContent !== null) {
      fs.writeFileSync(snapshotFile, savedContent, 'utf-8');
    } else {
      try { fs.unlinkSync(snapshotFile); } catch {}
    }
  });

  it('saves daily snapshot to JSONL file', async () => {
    const agent = await getAgent();
    try { fs.unlinkSync(snapshotFile); } catch {}

    (agent as any).trackTrends(makeSnapshot({ date: '2026-05-30' }));

    const content = fs.readFileSync(snapshotFile, 'utf-8');
    expect(content).toContain('2026-05-30');
    expect(content).toContain('"totalSessions":5');
  });

  it('returns empty when < 3 days of history', async () => {
    const agent = await getAgent();
    fs.writeFileSync(snapshotFile, JSON.stringify(makeSnapshot({ date: '2026-05-28' })) + '\n', 'utf-8');

    const result = (agent as any).trackTrends(makeSnapshot({ date: '2026-05-29' }));
    expect(result).toEqual([]);
  });

  it('detects sensitiveOps increasing trend', async () => {
    const agent = await getAgent();

    const lines: string[] = [];
    for (let i = 7; i >= 1; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      lines.push(JSON.stringify(makeSnapshot({ date: d, sensitiveOpsSessions: 1 })));
    }
    fs.writeFileSync(snapshotFile, lines.join('\n') + '\n', 'utf-8');

    const today = new Date().toISOString().slice(0, 10);
    const result = (agent as any).trackTrends(makeSnapshot({ date: today, sensitiveOpsSessions: 4 }));

    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.some((r: string) => r.includes('敏感操作'))).toBe(true);
  });

  it('detects capture rate declining trend', async () => {
    const agent = await getAgent();

    const lines: string[] = [];
    for (let i = 7; i >= 1; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      lines.push(JSON.stringify(makeSnapshot({ date: d, deepAnalysisCount: 3, missingCaptureCount: 0 })));
    }
    fs.writeFileSync(snapshotFile, lines.join('\n') + '\n', 'utf-8');

    const today = new Date().toISOString().slice(0, 10);
    const result = (agent as any).trackTrends(makeSnapshot({
      date: today, deepAnalysisCount: 3, missingCaptureCount: 3,
    }));

    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.some((r: string) => r.includes('捕获率下降'))).toBe(true);
  });

  it('detects avgTurns increasing trend', async () => {
    const agent = await getAgent();

    const lines: string[] = [];
    for (let i = 7; i >= 1; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      lines.push(JSON.stringify(makeSnapshot({ date: d, avgTurns: 10, totalSessions: 5 })));
    }
    fs.writeFileSync(snapshotFile, lines.join('\n') + '\n', 'utf-8');

    const today = new Date().toISOString().slice(0, 10);
    const result = (agent as any).trackTrends(makeSnapshot({ date: today, avgTurns: 30, totalSessions: 5 }));

    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.some((r: string) => r.includes('会话长度上升'))).toBe(true);
  });

  it('deduplicates snapshots by date', async () => {
    const agent = await getAgent();

    const today = new Date().toISOString().slice(0, 10);
    const lines: string[] = [];
    for (let i = 5; i >= 1; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      lines.push(JSON.stringify(makeSnapshot({ date: d, totalSessions: 3 })));
    }
    lines.push(JSON.stringify(makeSnapshot({ date: today, totalSessions: 1 })));
    fs.writeFileSync(snapshotFile, lines.join('\n') + '\n', 'utf-8');

    (agent as any).trackTrends(makeSnapshot({ date: today, totalSessions: 10 }));

    const content = fs.readFileSync(snapshotFile, 'utf-8');
    const todayEntries = content.split('\n').filter(Boolean).filter(l => l.includes(today));
    expect(todayEntries.length).toBe(1);
    expect(todayEntries[0]).toContain('"totalSessions":10');
  });

  it('keeps only last 30 days of snapshots', async () => {
    const agent = await getAgent();

    const lines: string[] = [];
    for (let i = 35; i >= 1; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      lines.push(JSON.stringify(makeSnapshot({ date: d })));
    }
    fs.writeFileSync(snapshotFile, lines.join('\n') + '\n', 'utf-8');

    const today = new Date().toISOString().slice(0, 10);
    (agent as any).trackTrends(makeSnapshot({ date: today }));

    const content = fs.readFileSync(snapshotFile, 'utf-8');
    const entries = content.split('\n').filter(Boolean);
    expect(entries.length).toBeLessThanOrEqual(31); // 30 historical + today
  });

  it('returns empty when no significant trend changes', async () => {
    const agent = await getAgent();

    const lines: string[] = [];
    for (let i = 7; i >= 1; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      lines.push(JSON.stringify(makeSnapshot({
        date: d, sensitiveOpsSessions: 0, deepAnalysisCount: 3,
        missingCaptureCount: 0, avgTurns: 10, totalSessions: 5,
      })));
    }
    fs.writeFileSync(snapshotFile, lines.join('\n') + '\n', 'utf-8');

    const today = new Date().toISOString().slice(0, 10);
    const result = (agent as any).trackTrends(makeSnapshot({
      date: today, sensitiveOpsSessions: 0, deepAnalysisCount: 3,
      missingCaptureCount: 0, avgTurns: 10, totalSessions: 5,
    }));

    expect(result).toEqual([]);
  });
});
