/**
 * monitoring 域契约测试：六端点实体 parity + 响应壳 + windowDays query。
 * 正本 = apps/api/src/modules/monitoring/monitoring.service.ts +
 * current-wu-context.ts + metrics.types.ts。
 */

import { describe, it, expect } from 'vitest';
import {
  agentCurrentWorkUnitSchema,
  type AgentCurrentWorkUnit,
  agentPmoSummarySchema,
  type AgentPmoSummary,
  agentInfoSchema,
  type AgentInfo,
  agentSummarySchema,
  type AgentSummary,
  monitoringStatsSchema,
  type MonitoringStats,
  flywheelStatsSchema,
  type FlywheelStats,
  overheadStatsSchema,
  type OverheadStats,
  humanInterventionMetricsSchema,
  roleMetricsSchema,
  alertMetricsSchema,
  stuckMetricsSchema,
  type StuckMetrics,
  failure24hMetricsSchema,
  type Failure24hMetrics,
  evidenceMetricsSchema,
  type EvidenceMetrics,
  overviewMetricsSchema,
  stepCacheHitRateSchema,
  cacheHitRateMetricsSchema,
  type CacheHitRateMetrics,
  sectionTrimMetricsSchema,
  efficiencyMetricsSchema,
  type EfficiencyMetrics,
  monitoringWindowQuerySchema,
  agentSummaryResponseSchema,
  overviewMetricsResponseSchema,
  efficiencyMetricsResponseSchema,
} from '../monitoring.js';
import * as contractIndex from '../index.js';

const wu: AgentCurrentWorkUnit = {
  id: 'wu-1', title: '登录功能', type: 'feature', status: 'active',
  claimedAt: '2026-07-18T10:00:00.000Z',
};
const pmo: AgentPmoSummary = { id: 'proj-1', pmoNumber: 'PMO-1', title: '重构' };

const agent: AgentInfo = {
  id: 'inst-1',
  roleId: 'role-1',
  name: 'developer',
  status: 'active',
  currentWorkUnitId: 'wu-1',
  startedAt: '2026-07-18T09:00:00.000Z',
  lastError: null,
  lastErrorAt: null,
  currentWorkUnit: wu,
  pmo,
  channelId: 'ch-1',
};

describe('agentInfoSchema / agentSummarySchema', () => {
  it('parity：AgentInfo fixture 通过校验；可空三件套（lastError/lastErrorAt/channelId）null 合法', () => {
    expect(agentCurrentWorkUnitSchema.parse(wu)).toEqual(wu);
    expect(agentPmoSummarySchema.parse(pmo)).toEqual(pmo);
    expect(agentInfoSchema.parse(agent)).toEqual(agent);
    // 无当前 WU：currentWorkUnit/pmo/channelId 全 null
    const idle: AgentInfo = {
      ...agent, currentWorkUnitId: null, currentWorkUnit: null, pmo: null, channelId: null,
    };
    expect(agentInfoSchema.parse(idle)).toEqual(idle);
    expect(() => agentInfoSchema.parse({ ...agent, roleId: undefined })).toThrow();
    expect(() => agentInfoSchema.parse({ ...agent, startedAt: undefined })).toThrow();
  });

  it('parity：AgentSummary fixture（agents + summary 计数）', () => {
    const summary: AgentSummary = {
      agents: [agent],
      summary: { total: 1, idle: 0, active: 1, error: 0, terminated: 0 },
    };
    expect(agentSummarySchema.parse(summary)).toEqual(summary);
    expect(agentSummaryResponseSchema.parse({ data: summary }).data.summary.active).toBe(1);
  });
});

describe('monitoringStatsSchema', () => {
  it('parity：MonitoringStats fixture', () => {
    const stats: MonitoringStats = {
      workunits: { total: 5, unassigned: 2, active: 1, in_review: 1, done: 1, blocked: 0, closed: 0 },
      agents: { total: 1, idle: 1, active: 0, terminated: 0 },
      recent: { completedLast24h: 1, failedLast24h: 0 },
    };
    expect(monitoringStatsSchema.parse(stats)).toEqual(stats);
  });
});

describe('flywheelStatsSchema / overheadStatsSchema', () => {
  it('parity：FlywheelStats fixture（source 词表 events/insufficient-data）', () => {
    const flywheel: FlywheelStats = {
      quality: 0.8, hitRate: 42, improvement: 3, freshness: 0.9,
      source: 'events', proposalsPendingReview: 2,
      extraction: { count30d: 5, totalTokens30d: 12000 },
      windowDays: 7, timestamp: '2026-07-27T00:00:00.000Z',
    };
    expect(flywheelStatsSchema.parse(flywheel)).toEqual(flywheel);
    expect(() => flywheelStatsSchema.parse({ ...flywheel, source: 'bogus' })).toThrow();
  });

  it('parity：OverheadStats fixture（avgExecutionTokens/avgOverheadRatio null = 不编造）', () => {
    const overhead: OverheadStats = {
      windowDays: 30, executions: 10, workUnits: 4,
      avgInjectedTokens: 500, injectedBudget: 927, injectedBudgetUsedPct: 54,
      avgExecutionTokens: null, executionCoveragePct: 0,
      avgOverheadRatio: null, overheadBudget: 0.2,
      extractionTokens: 800, source: 'insufficient-data',
      timestamp: '2026-07-27T00:00:00.000Z',
    };
    expect(overheadStatsSchema.parse(overhead)).toEqual(overhead);
    expect(() => overheadStatsSchema.parse({ ...overhead, avgExecutionTokens: undefined })).toThrow();
  });
});

describe('overviewMetricsSchema（D16 九组 + #456 + F6）', () => {
  const percentile = { count: 3, p50Hours: 1.5, p95Hours: null };
  const overview = {
    windowDays: 7,
    generatedAt: '2026-07-27T00:00:00.000Z',
    taskFlow: {
      description: 'd', byStatus: { active: 2 },
      dwell: { ...percentile, description: 'd' },
      createToClaim: { ...percentile, description: 'd' },
      claimToComplete: { ...percentile, description: 'd' },
      failuresByErrorType: { description: 'd', buckets: { verify: 1 } },
      steps: { description: 'd', count: 4, avgStepCount: 2.5, stuckWorkUnits: 0, avgStuckSteps: null },
    },
    intake: { description: 'd', humanMessages: 10, workUnitsCreated: 3, conversionPct: 30 },
    humanIntervention: {
      description: 'd', completedWorkUnits: 4, needInputCount: 1,
      reviewRejections: 2, mergeConflicts: 0, avgPerCompletedWu: 0.75,
    },
    cycleTime: { description: 'd', createToDone: percentile, avgHours: 2.1 },
    roles: {
      description: 'd',
      roles: [{
        profileId: 'p1', profileName: 'dev', claims: 3, completions: 2,
        avgDurationHours: 1.2, needInputClarify: 0, needInputExecution: 1,
      }],
    },
    quality: {
      description: 'd', verifyPassed: 3, verifyFailing: 1,
      verifyPassRatePct: 75, mergeConflicts: 0, merges: 2,
    },
    tokens: {
      description: 'd',
      totals: { injectedTokens: 100, executionTokens: 900, totalTokens: 1000 },
      workUnits: 2, avgTokensPerWu: 500, cacheHitRatePct: 40, cacheCoveragePct: 100,
      byRole: [{
        profileId: 'p1', profileName: 'dev', injectedTokens: 100,
        executionTokens: 900, totalTokens: 1000, workUnits: 2,
      }],
    },
    alerts: { description: 'd', last24h: 2, inWindow: 5, byLevel: { warning: 4, critical: 1 } },
    stuck: { description: 'd', blocked: 1, staleUnassigned: 2, stalledActive: 0 },
    failure24h: { description: 'd', n: 3, rate: 0.1, trend: 'up' },
    evidence: {
      description: 'd', engaged: 6, l1Approved: 5, l2Approved: 4, l3Approved: 3,
      selfReviewCount: 1, needsHuman: 2, derivedMismatch: 0,
      derivedByColumn: { todo: 1, doing: 2 },
    },
    source: 'events',
  };

  it('parity：完整 OverviewMetrics fixture 通过校验；前端消费六段嵌套必填', () => {
    expect(overviewMetricsSchema.parse(overview)).toEqual(overview);
    expect(overviewMetricsResponseSchema.parse({ data: overview }).data.stuck.blocked).toBe(1);
    // 前端消费组 parity（必填字段删除即拒）
    expect(() => humanInterventionMetricsSchema.parse({
      ...overview.humanIntervention, avgPerCompletedWu: undefined,
    })).toThrow();
    expect(() => roleMetricsSchema.parse({ description: 'd' })).toThrow();
    expect(() => alertMetricsSchema.parse({ ...overview.alerts, last24h: undefined })).toThrow();
    const stuck: StuckMetrics = { description: 'd', blocked: 0, staleUnassigned: 0, stalledActive: 0 };
    expect(stuckMetricsSchema.parse(stuck)).toEqual(stuck);
    const failure: Failure24hMetrics = { description: 'd', n: 0, rate: null, trend: null };
    expect(failure24hMetricsSchema.parse(failure)).toEqual(failure);
    expect(() => failure24hMetricsSchema.parse({ ...failure, trend: 'bogus' })).toThrow();
    const evidence: EvidenceMetrics = overview.evidence;
    expect(evidenceMetricsSchema.parse(evidence)).toEqual(evidence);
    expect(() => evidenceMetricsSchema.parse({ ...evidence, derivedByColumn: undefined })).toThrow();
  });
});

describe('efficiencyMetricsSchema（#120）', () => {
  const cacheHitRate: CacheHitRateMetrics = {
    description: 'd',
    windowDays: 7,
    overall: { cacheReadTokens: 1400, inputTokens: 1600, hitRatePct: 47, events: 4, workUnits: 3 },
    steps: [{
      executionId: 'e1', workUnitId: 'wu-1', createdAt: 't',
      inputTokens: 400, cacheReadTokens: 350, hitRatePct: 47,
    }],
    byWorkUnit: [{ workUnitId: 'wu-1', cacheReadTokens: 1400, inputTokens: 1600, hitRatePct: 47, events: 4 }],
    byRole: [{ profileId: 'p1', profileName: 'dev', cacheReadTokens: 1400, inputTokens: 1600, hitRatePct: 47, events: 4 }],
    byDay: [{ day: '2026-07-26', cacheReadTokens: 1400, inputTokens: 1600, hitRatePct: 47, events: 4 }],
    coveragePct: 80,
    source: 'events',
  };

  it('parity：CacheHitRateMetrics fixture（hitRatePct null 合法）', () => {
    expect(stepCacheHitRateSchema.parse(cacheHitRate.steps[0])).toEqual(cacheHitRate.steps[0]);
    expect(cacheHitRateMetricsSchema.parse(cacheHitRate)).toEqual(cacheHitRate);
    expect(() => cacheHitRateMetricsSchema.parse({ ...cacheHitRate, byDay: undefined })).toThrow();
  });

  it('parity：EfficiencyMetrics fixture（cacheHitRate + sectionTrim 两段）', () => {
    const efficiency: EfficiencyMetrics = {
      windowDays: 7,
      generatedAt: '2026-07-27T00:00:00.000Z',
      cacheHitRate,
      sectionTrim: {
        description: 'd', windowDays: 7,
        bySection: [{
          section: 'knowledge', trimCount: 2, avgOriginalTokens: 500,
          avgTrimmedTokens: 300, avgTrimPct: 40,
        }],
        totals: { trimEvents: 3, totalOriginalTokens: 1500, totalTrimmedTokens: 900 },
        source: 'events',
      },
    };
    expect(sectionTrimMetricsSchema.parse(efficiency.sectionTrim)).toEqual(efficiency.sectionTrim);
    expect(efficiencyMetricsSchema.parse(efficiency)).toEqual(efficiency);
    expect(efficiencyMetricsResponseSchema.parse({ data: efficiency }).data.cacheHitRate.coveragePct).toBe(80);
  });
});

describe('monitoringWindowQuerySchema', () => {
  it('windowDays 可选（缺省 7、1-90 clamp、非数值 → 缺省均在 handler）', () => {
    expect(monitoringWindowQuerySchema.parse({})).toEqual({});
    expect(monitoringWindowQuerySchema.parse({ windowDays: '30' }).windowDays).toBe('30');
  });
});

describe('index.ts 出口', () => {
  it('monitoring 域 schema 经 index 导出', () => {
    expect(contractIndex.agentSummarySchema).toBeDefined();
    expect(contractIndex.overviewMetricsResponseSchema).toBeDefined();
    expect(contractIndex.efficiencyMetricsResponseSchema).toBeDefined();
  });
});
