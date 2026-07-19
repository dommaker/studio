/**
 * M2 封装开销聚合 — aggregateOverheadEvents 纯函数数学 + getOverheadStats 文件链路。
 * M1 飞轮透传 — getFlywheelStats 经 DI 假 knowledge 源验证组合逻辑。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  MonitoringService,
  aggregateOverheadEvents,
  INJECTED_TOKEN_BUDGET,
  OVERHEAD_RATIO_BUDGET,
  type KnowledgeMetricsSource,
} from '../monitoring.service.js';

const DAYS = 24 * 3600 * 1000;
const NOW = Date.now();

function tokenEvent(injected: number, execution: number | null, createdAt: Date, workUnitId = 'wu-1'): any {
  return {
    type: 'workunit:tokens',
    source: 'agent-loop',
    payload: JSON.stringify({
      workUnitId,
      injectedTokens: injected,
      injectedSource: 'estimate:chars/4',
      executionTokens: execution,
      executionSource: execution !== null ? 'cli-usage' : 'unavailable',
      totalTokens: injected + (execution ?? 0),
    }),
    createdAt: createdAt.toISOString(),
  };
}

function extractionEvent(totalTokens: number, createdAt: Date): any {
  return {
    type: 'knowledge:extraction',
    source: 'conversation:wu-1',
    payload: JSON.stringify({ totalTokens }),
    createdAt: createdAt.toISOString(),
  };
}

describe('M2: aggregateOverheadEvents math', () => {
  it('computes averages, budget pct, overhead ratio and extraction tokens', () => {
    const rows = [
      tokenEvent(400, 10_000, new Date(NOW - 1 * DAYS)),
      tokenEvent(600, 20_000, new Date(NOW - 2 * DAYS), 'wu-2'),
      tokenEvent(200, null, new Date(NOW - 3 * DAYS), 'wu-3'), // CLI 未回报 usage
      extractionEvent(1500, new Date(NOW - 1 * DAYS)),
      extractionEvent(500, new Date(NOW - 2 * DAYS)),
      // 窗口外（40 天前）应被忽略
      tokenEvent(9_999, 99_999, new Date(NOW - 40 * DAYS), 'wu-old'),
      // 噪音事件应被忽略
      { type: 'knowledge:consumption', source: 'x', payload: '{}', createdAt: new Date(NOW).toISOString() },
    ];

    const s = aggregateOverheadEvents(rows, { now: NOW });

    expect(s.source).toBe('events');
    expect(s.executions).toBe(3);
    expect(s.workUnits).toBe(3);
    expect(s.avgInjectedTokens).toBe(400); // (400+600+200)/3
    expect(s.injectedBudget).toBe(INJECTED_TOKEN_BUDGET);
    expect(s.injectedBudgetUsedPct).toBe(20); // 400/2000
    expect(s.avgExecutionTokens).toBe(15_000); // (10000+20000)/2，null 不计入
    expect(s.executionCoveragePct).toBe(67); // 2/3
    // mean(400/10000, 600/20000) = mean(0.04, 0.03) = 0.035
    expect(s.avgOverheadRatio).toBe(0.035);
    expect(s.overheadBudget).toBe(OVERHEAD_RATIO_BUDGET);
    expect(s.extractionTokens).toBe(2000); // 单独核算，不计入注入
  });

  it('returns explicit zeros/nulls + insufficient-data when no workunit:tokens events', () => {
    const s = aggregateOverheadEvents([extractionEvent(300, new Date(NOW))], { now: NOW });
    expect(s.source).toBe('insufficient-data');
    expect(s.executions).toBe(0);
    expect(s.avgInjectedTokens).toBe(0);
    expect(s.injectedBudgetUsedPct).toBe(0);
    expect(s.avgExecutionTokens).toBeNull();
    expect(s.avgOverheadRatio).toBeNull();
    expect(s.extractionTokens).toBe(300); // 提取活动独立于 workunit 事件存在
  });

  it('skips corrupt payload lines instead of fabricating zeros', () => {
    const rows = [
      tokenEvent(200, 10_000, new Date(NOW)),
      { type: 'workunit:tokens', source: 'agent-loop', payload: '{broken', createdAt: new Date(NOW).toISOString() },
    ];
    const s = aggregateOverheadEvents(rows, { now: NOW });
    expect(s.executions).toBe(1);
    expect(s.avgInjectedTokens).toBe(200);
  });
});

describe('M2: MonitoringService.getOverheadStats (fixture file)', () => {
  it('reads events file and aggregates', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overhead-stats-'));
    const eventsFile = path.join(dir, 'studio-events.jsonl');
    try {
      const lines = [
        JSON.stringify(tokenEvent(800, 16_000, new Date())),
        JSON.stringify(extractionEvent(700, new Date())),
      ];
      fs.writeFileSync(eventsFile, lines.join('\n') + '\n', 'utf-8');

      const service = new MonitoringService();
      const s = await service.getOverheadStats({ eventsFile });
      expect(s.source).toBe('events');
      expect(s.executions).toBe(1);
      expect(s.avgInjectedTokens).toBe(800);
      expect(s.injectedBudgetUsedPct).toBe(40);
      expect(s.avgOverheadRatio).toBe(0.05);
      expect(s.extractionTokens).toBe(700);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('missing events file → insufficient-data (no throw)', async () => {
    const service = new MonitoringService();
    const s = await service.getOverheadStats({ eventsFile: path.join(os.tmpdir(), `no-such-${Date.now()}.jsonl`) });
    expect(s.source).toBe('insufficient-data');
  });
});

describe('M1: MonitoringService.getFlywheelStats (DI knowledge source)', () => {
  it('combines flywheel metrics + audit sections without recomputing', async () => {
    const fakeKnowledge: KnowledgeMetricsSource = {
      getFlywheelMetrics: async () => ({
        quality: 55, hitRate: 75, improvement: 12, freshness: 60,
        timestamp: new Date().toISOString(), source: 'events',
      }),
      getAuditReport: async () => ({
        findings: [], trend: 'improving', timestamp: new Date().toISOString(),
        eventCounts: { windowDays: 30, consumption: 4, outcomeSuccess: 3, outcomeFailure: 1, extraction: 2, source: 'events' },
        entries: { total: 10, byMaturity: { draft: 3, proven: 7 }, source: 'store' },
        topReferenced: [],
        extractionActivity: { count: 2, totalTokens: 3210, lastAt: '2026-07-19T00:00:00Z', source: 'events' },
      }),
    };

    const service = new MonitoringService(undefined, fakeKnowledge);
    const s = await service.getFlywheelStats();

    expect(s.hitRate).toBe(75);
    expect(s.improvement).toBe(12);
    expect(s.quality).toBe(55);
    expect(s.freshness).toBe(60);
    expect(s.source).toBe('events');
    expect(s.proposalsPendingReview).toBe(3); // byMaturity.draft
    expect(s.extraction).toEqual({ count30d: 2, totalTokens30d: 3210 });
    expect(s.windowDays).toBe(30);
  });

  it('reports proposalsPendingReview=0 when no drafts', async () => {
    const fakeKnowledge: KnowledgeMetricsSource = {
      getFlywheelMetrics: async () => ({
        quality: 0, hitRate: 0, improvement: 0, freshness: 0,
        timestamp: new Date().toISOString(), source: 'insufficient-data',
      }),
      getAuditReport: async () => ({
        findings: [], trend: 'insufficient-data', timestamp: new Date().toISOString(),
        eventCounts: { windowDays: 30, consumption: 0, outcomeSuccess: 0, outcomeFailure: 0, extraction: 0, source: 'insufficient-data' },
        entries: { total: 0, byMaturity: {}, source: 'store' },
        topReferenced: [],
        extractionActivity: { count: 0, totalTokens: 0, lastAt: null, source: 'insufficient-data' },
      }),
    };
    const service = new MonitoringService(undefined, fakeKnowledge);
    const s = await service.getFlywheelStats();
    expect(s.source).toBe('insufficient-data');
    expect(s.proposalsPendingReview).toBe(0);
  });
});
