// Contract test: Monitoring Routes — MVP-2 + MVP-6
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetAgentSummary, mockGetStats, mockGetOverviewMetrics, mockGetEfficiencyMetrics } = vi.hoisted(() => {
  const percentile = { count: 0, p50Hours: null, p95Hours: null };
  return {
    mockGetAgentSummary: vi.fn().mockResolvedValue({
      agents: [{
        id: 'inst-1', roleId: 'role-1', name: 'test-agent', status: 'idle', currentWorkUnitId: null,
        startedAt: '2026-01-01T00:00:00Z', lastError: null, lastErrorAt: null,
        currentWorkUnit: null, pmo: null, channelId: null,
      }],
      summary: { total: 1, idle: 1, active: 0, error: 0, terminated: 0 },
    }),
    mockGetStats: vi.fn().mockResolvedValue({
      workunits: { total: 5, unassigned: 2, active: 1, in_review: 1, done: 1, blocked: 0, closed: 0 },
      agents: { total: 1, idle: 1, active: 0, terminated: 0 },
      recent: { completedLast24h: 1, failedLast24h: 0 },
    }),
    mockGetOverviewMetrics: vi.fn().mockResolvedValue({
      windowDays: 7, generatedAt: '2026-07-27T00:00:00.000Z', source: 'events',
      taskFlow: {
        description: 'task flow', byStatus: {},
        dwell: { ...percentile, description: 'dwell' },
        createToClaim: { ...percentile, description: 'create to claim' },
        claimToComplete: { ...percentile, description: 'claim to complete' },
        failuresByErrorType: { description: 'failures', buckets: {} },
        steps: { description: 'steps', count: 0, avgStepCount: null, stuckWorkUnits: 0, avgStuckSteps: null },
      },
      intake: { description: 'intake', humanMessages: 0, workUnitsCreated: 0, conversionPct: null },
      humanIntervention: {
        description: 'human intervention', completedWorkUnits: 2, needInputCount: 1,
        reviewRejections: 0, mergeConflicts: 0, avgPerCompletedWu: 0.5,
      },
      cycleTime: { description: 'cycle', createToDone: percentile, avgHours: null },
      roles: { description: 'roles', roles: [] },
      quality: { description: 'quality', verifyPassed: 0, verifyFailing: 0, verifyPassRatePct: null, mergeConflicts: 0, merges: 0 },
      tokens: {
        description: 'tokens', totals: { injectedTokens: 0, executionTokens: 0, totalTokens: 0 },
        workUnits: 0, avgTokensPerWu: null, cacheHitRatePct: null, cacheCoveragePct: 0, byRole: [],
      },
      alerts: { description: 'alerts', last24h: 0, inWindow: 0, byLevel: {} },
      stuck: { description: 'stuck', blocked: 0, staleUnassigned: 0, stalledActive: 0 },
      failure24h: { description: 'failures', n: 0, rate: null, trend: null },
      evidence: {
        description: 'evidence', engaged: 0, l1Approved: 0, l2Approved: 0, l3Approved: 0,
        selfReviewCount: 0, needsHuman: 0,
        mergeDivergence: 0, doneWithoutReceipt: 0, derivedMismatch: 0, derivedByColumn: {},
      },
      effects: {
        description: 'effects', byStatus: {}, receiptsByOutcome: {}, recoveryChecks: 0, duplicatesPrevented: 0,
      },
      knowledgePublishing: {
        description: 'knowledge publishing', byState: {}, failed: 0, retryAfter: 0, cardFailed: 0, staleRunning: 0, items: [],
      },
    }),
    mockGetEfficiencyMetrics: vi.fn().mockResolvedValue({
      windowDays: 7, generatedAt: '2026-07-27T00:00:00.000Z',
      cacheHitRate: {
        description: 'cache', windowDays: 7, source: 'events',
        overall: { hitRatePct: 47, cacheReadTokens: 1400, inputTokens: 1600, events: 4, workUnits: 3 },
        steps: [], byWorkUnit: [], byRole: [], byDay: [], coveragePct: 100,
      },
      sectionTrim: {
        description: 'trim', windowDays: 7, source: 'events',
        totals: { trimEvents: 3, totalOriginalTokens: 100, totalTrimmedTokens: 80 },
        bySection: [{ section: 'knowledge', trimCount: 2, avgOriginalTokens: 50, avgTrimmedTokens: 40, avgTrimPct: 20 }],
      },
      contextComparison: {
        description: 'context', windowDays: 7, qualityNotRegressed: null, rolloutEligible: false, source: 'insufficient-data',
        full: {
          steps: 0, presentedTokens: 0, repeatedTokens: 0, repeatedTokenPct: 0, overflows: 0,
          recoveryAttempts: 0, recoverySucceeded: 0, humanInputsAfterRecovery: 0,
          succeededSteps: 0, completedSteps: 0, successRatePct: null, completionRatePct: null,
        },
        delta: {
          steps: 0, presentedTokens: 0, repeatedTokens: 0, repeatedTokenPct: 0, overflows: 0,
          recoveryAttempts: 0, recoverySucceeded: 0, humanInputsAfterRecovery: 0,
          succeededSteps: 0, completedSteps: 0, successRatePct: null, completionRatePct: null,
        },
      },
    }),
  };
});

vi.mock('../monitoring.service.js', () => ({
  MonitoringService: vi.fn(function MonitoringService() {
    return {
      getAgentSummary: mockGetAgentSummary,
      getStats: mockGetStats,
    };
  }),
}));

vi.mock('../metrics.service.js', () => ({
  MetricsService: vi.fn(function MetricsService() {
    return { getOverviewMetrics: mockGetOverviewMetrics, getEfficiencyMetrics: mockGetEfficiencyMetrics };
  }),
}));

import router from '../monitoring.routes.js';

function mockRes() {
  const res: any = { statusCode: 200, body: null };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (data: any) => { res.body = data; return res; };
  return res;
}

describe('Monitoring Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /agents returns agent summary', async () => {
    const req = {} as any;
    const res = mockRes();
    const handler = router.stack.find((l: any) => l.route?.path === '/agents')?.route?.stack[0]?.handle;
    await handler!(req, res, () => {});
    expect(res.statusCode).toBe(200);
    // 契约驱动迁移（批次 5/7）：响应统一 `{ data }` 壳
    expect(res.body.data.agents).toHaveLength(1);
    expect(res.body.data.summary.total).toBe(1);
  });

  it('GET /stats returns monitoring stats', async () => {
    const req = {} as any;
    const res = mockRes();
    const handler = router.stack.find((l: any) => l.route?.path === '/stats')?.route?.stack[0]?.handle;
    await handler!(req, res, () => {});
    expect(res.statusCode).toBe(200);
    expect(res.body.data.workunits.total).toBe(5);
    expect(res.body.data.agents.total).toBe(1);
    expect(res.body.data.recent.completedLast24h).toBe(1);
  });

  it('GET /agents returns 500 on service error', async () => {
    mockGetAgentSummary.mockRejectedValueOnce(new Error('DB error'));
    const req = {} as any;
    const res = mockRes();
    const handler = router.stack.find((l: any) => l.route?.path === '/agents')?.route?.stack[0]?.handle;
    await handler!(req, res, () => {});
    expect(res.statusCode).toBe(500);
    // 错误壳 code 归一：INTERNAL_ERROR → INTERNAL（message = 实际错误消息不变）
    expect(res.body.error.code).toBe('INTERNAL');
  });

  it('GET /overview returns D16 聚合指标（默认窗口）', async () => {
    const req = { query: {} } as any;
    const res = mockRes();
    const handler = router.stack.find((l: any) => l.route?.path === '/overview')?.route?.stack[0]?.handle;
    await handler!(req, res, () => {});
    expect(res.statusCode).toBe(200);
    expect(res.body.data.windowDays).toBe(7);
    expect(res.body.data.humanIntervention.avgPerCompletedWu).toBe(0.5);
    expect(mockGetOverviewMetrics).toHaveBeenCalledWith({ windowDays: undefined });
  });

  it('GET /overview 透传 windowDays 并 clamp 到 1-90', async () => {
    const handler = router.stack.find((l: any) => l.route?.path === '/overview')?.route?.stack[0]?.handle;

    const res1 = mockRes();
    await handler!({ query: { windowDays: '30' } } as any, res1, () => {});
    expect(mockGetOverviewMetrics).toHaveBeenCalledWith({ windowDays: 30 });

    const res2 = mockRes();
    await handler!({ query: { windowDays: '999' } } as any, res2, () => {});
    expect(mockGetOverviewMetrics).toHaveBeenCalledWith({ windowDays: 90 });

    const res3 = mockRes();
    await handler!({ query: { windowDays: 'abc' } } as any, res3, () => {});
    expect(mockGetOverviewMetrics).toHaveBeenCalledWith({ windowDays: undefined });
  });

  it('GET /overview returns 500 on service error', async () => {
    mockGetOverviewMetrics.mockRejectedValueOnce(new Error('scan error'));
    const req = { query: {} } as any;
    const res = mockRes();
    const handler = router.stack.find((l: any) => l.route?.path === '/overview')?.route?.stack[0]?.handle;
    await handler!(req, res, () => {});
    expect(res.statusCode).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL');
  });

  it('GET /efficiency returns #120 缓存命中率 + 段 trim 率（默认窗口）', async () => {
    const req = { query: {} } as any;
    const res = mockRes();
    const handler = router.stack.find((l: any) => l.route?.path === '/efficiency')?.route?.stack[0]?.handle;
    await handler!(req, res, () => {});
    expect(res.statusCode).toBe(200);
    expect(res.body.data.cacheHitRate.overall.hitRatePct).toBe(47);
    expect(res.body.data.sectionTrim.totals.trimEvents).toBe(3);
    expect(mockGetEfficiencyMetrics).toHaveBeenCalledWith({ windowDays: undefined });
  });

  it('GET /efficiency 透传 windowDays 并 clamp 到 1-90', async () => {
    const handler = router.stack.find((l: any) => l.route?.path === '/efficiency')?.route?.stack[0]?.handle;
    await handler!({ query: { windowDays: '30' } } as any, mockRes(), () => {});
    expect(mockGetEfficiencyMetrics).toHaveBeenCalledWith({ windowDays: 30 });

    await handler!({ query: { windowDays: '999' } } as any, mockRes(), () => {});
    expect(mockGetEfficiencyMetrics).toHaveBeenCalledWith({ windowDays: 90 });

    await handler!({ query: { windowDays: 'abc' } } as any, mockRes(), () => {});
    expect(mockGetEfficiencyMetrics).toHaveBeenCalledWith({ windowDays: undefined });
  });

  it('GET /efficiency returns 500 on service error', async () => {
    mockGetEfficiencyMetrics.mockRejectedValueOnce(new Error('scan error'));
    const req = { query: {} } as any;
    const res = mockRes();
    const handler = router.stack.find((l: any) => l.route?.path === '/efficiency')?.route?.stack[0]?.handle;
    await handler!(req, res, () => {});
    expect(res.statusCode).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL');
  });
});
