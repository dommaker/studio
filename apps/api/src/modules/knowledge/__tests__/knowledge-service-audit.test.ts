/**
 * M1 审计度量 — getAuditReport() 从 fixture 事件流 + mock store 实算。
 *
 * 与 knowledge-service-flywheel.test.ts 同一约定：tmp fixture 事件文件
 * （opts.eventsFile 注入），不 mock FileStore，验证真实计算链路。
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { KnowledgeService } from '../knowledge-service.js';

function createKS(entries: any[] = []) {
  const store = {
    list: vi.fn(() => entries),
    get: vi.fn((id: string) => entries.find(e => e.id === id) || null),
    save: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  const deps = {
    store: store as any,
    lifecycle: { recordReference: vi.fn() } as any,
    ingest: { ingestEntry: vi.fn() } as any,
    linter: { validateEntry: vi.fn(() => []) } as any,
    query: {} as any,
    eventEmitter: { emit: vi.fn() } as any,
  };
  return { ks: new KnowledgeService(deps), store };
}

// ── Fixture helpers（与 recordConsumption/recordOutcome/extractFromConversation 写入形态一致）──

function consumptionLine(createdAt: Date): string {
  return JSON.stringify({
    type: 'knowledge:consumption',
    source: 'prompt-inject',
    payload: JSON.stringify({ entryIds: ['k-1'], count: 1 }),
    createdAt: createdAt.toISOString(),
  });
}

function outcomeLine(success: boolean, createdAt: Date): string {
  return JSON.stringify({
    type: `knowledge:outcome:${success ? 'success' : 'failure'}`,
    source: 'claude',
    payload: JSON.stringify({ executionId: 'exec-1', agentType: 'claude', success, consumedKnowledge: ['k-1'] }),
    createdAt: createdAt.toISOString(),
  });
}

function extractionLine(totalTokens: number, createdAt: Date): string {
  return JSON.stringify({
    type: 'knowledge:extraction',
    source: 'conversation:wu-1',
    payload: JSON.stringify({ trigger: 'task-complete', workUnitId: 'wu-1', entryCount: 1, promptTokens: totalTokens - 100, completionTokens: 100, totalTokens, durationMs: 800 }),
    createdAt: createdAt.toISOString(),
  });
}

function withTmpEvents(lines: string[], fn: (eventsFile: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-report-'));
  const eventsFile = path.join(dir, 'studio-events.jsonl');
  fs.writeFileSync(eventsFile, lines.join('\n') + (lines.length > 0 ? '\n' : ''), 'utf-8');
  return fn(eventsFile).finally(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

const DAYS = 24 * 3600 * 1000;

describe('KnowledgeService M1: getAuditReport from fixture events + store', () => {
  it('computes eventCounts / entries / topReferenced / extractionActivity from real sources', async () => {
    const now = Date.now();
    const lines = [
      consumptionLine(new Date(now - 1 * 3600_000)),
      consumptionLine(new Date(now - 2 * 3600_000)),
      outcomeLine(true, new Date(now - 1 * DAYS)),
      outcomeLine(false, new Date(now - 2 * DAYS)),
      extractionLine(1200, new Date(now - 3 * 3600_000)),
      extractionLine(800, new Date(now - 1 * 3600_000)),
      // 窗口外（40 天前）应被忽略
      consumptionLine(new Date(now - 40 * DAYS)),
      // 噪音事件应被忽略
      JSON.stringify({ type: 'agent_session', source: 'agent-executor', payload: '{}', createdAt: new Date(now).toISOString() }),
    ];

    const entries = [
      { id: 'k-1', title: '热门条目', maturity: 'proven', referencedBy: ['a:2026-07-01', 'b:2026-07-02', 'c:2026-07-03'] },
      { id: 'k-2', title: '普通条目', maturity: 'draft', referencedBy: ['a:2026-07-01'] },
      { id: 'k-3', title: '冷门条目', maturity: 'verified', referencedBy: [] },
    ];

    await withTmpEvents(lines, async (eventsFile) => {
      const { ks } = createKS(entries);
      const r = await ks.getAuditReport({ eventsFile });

      // 事件计数（窗口内：consumption 2、success 1、failure 1、extraction 2）
      expect(r.eventCounts.source).toBe('events');
      expect(r.eventCounts.windowDays).toBe(30);
      expect(r.eventCounts.consumption).toBe(2);
      expect(r.eventCounts.outcomeSuccess).toBe(1);
      expect(r.eventCounts.outcomeFailure).toBe(1);
      expect(r.eventCounts.extraction).toBe(2);

      // store 分区
      expect(r.entries.source).toBe('store');
      expect(r.entries.total).toBe(3);
      expect(r.entries.byMaturity).toEqual({ proven: 1, draft: 1, verified: 1 });

      // top-referenced（按 referencedBy 计数降序，过滤 0 引用）
      expect(r.topReferenced.map(t => t.id)).toEqual(['k-1', 'k-2']);
      expect(r.topReferenced[0].references).toBe(3);

      // 提取活动
      expect(r.extractionActivity.source).toBe('events');
      expect(r.extractionActivity.count).toBe(2);
      expect(r.extractionActivity.totalTokens).toBe(2000);
      expect(typeof r.extractionActivity.lastAt).toBe('string');

      // findings：有 draft → proposals-pending-review
      expect(r.findings.some(f => f.type === 'proposals-pending-review')).toBe(true);
      expect(r).toHaveProperty('trend');
      expect(r).toHaveProperty('timestamp');
    });
  });

  it('returns explicit zeros + insufficient-data markers when no events exist', async () => {
    await withTmpEvents([], async (eventsFile) => {
      const { ks } = createKS([]);
      const r = await ks.getAuditReport({ eventsFile });

      expect(r.eventCounts.source).toBe('insufficient-data');
      expect(r.eventCounts.consumption).toBe(0);
      expect(r.eventCounts.outcomeSuccess).toBe(0);
      expect(r.eventCounts.outcomeFailure).toBe(0);
      expect(r.eventCounts.extraction).toBe(0);
      expect(r.extractionActivity.source).toBe('insufficient-data');
      expect(r.extractionActivity.totalTokens).toBe(0);
      expect(r.extractionActivity.lastAt).toBeNull();
      expect(r.trend).toBe('insufficient-data');
      // 空库 + 无事件 → 两个对应 finding
      expect(r.findings.some(f => f.type === 'empty-store')).toBe(true);
      expect(r.findings.some(f => f.type === 'no-events')).toBe(true);
    });
  });

  it('tolerates missing events file (source markers, no throw)', async () => {
    const { ks } = createKS([{ id: 'k-1', title: 'x', maturity: 'active', referencedBy: [] }]);
    const r = await ks.getAuditReport({ eventsFile: path.join(os.tmpdir(), `no-such-file-${Date.now()}.jsonl`) });
    expect(r.eventCounts.source).toBe('insufficient-data');
    expect(r.entries.total).toBe(1); // store 分区不受影响
  });

  it('derives trend from outcome success halves (declining)', async () => {
    const now = Date.now();
    const lines = [
      // 前半窗口全成功，后半窗口全失败 → declining
      outcomeLine(true, new Date(now - 25 * DAYS)),
      outcomeLine(true, new Date(now - 22 * DAYS)),
      outcomeLine(false, new Date(now - 2 * DAYS)),
      outcomeLine(false, new Date(now - 1 * DAYS)),
      outcomeLine(false, new Date(now - 12 * 3600_000)),
    ];
    await withTmpEvents(lines, async (eventsFile) => {
      const { ks } = createKS([]);
      const r = await ks.getAuditReport({ eventsFile });
      expect(r.trend).toBe('declining');
      expect(r.findings.some(f => f.type === 'failures-exceed-successes')).toBe(true);
    });
  });
});
