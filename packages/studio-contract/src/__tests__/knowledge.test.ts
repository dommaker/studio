/**
 * knowledge 域契约测试：实体/请求/响应 schema 的接受-拒绝边界 +
 * UnifiedKnowledgeEntry/KnowledgeEntryItem/Resolution/KnowledgeSearchResult/
 * KnowledgeMaintenanceResult parity。正本 = knowledge-service.ts / knowledge-types.ts /
 * resolution.service.ts / engine/unified-query.ts 与各 routes 实测 wire 行为。
 */

import { describe, it, expect } from 'vitest';
import {
  knowledgeEntrySchema,
  unifiedKnowledgeEntrySchema,
  type UnifiedKnowledgeEntry,
  knowledgeEntryItemSchema,
  type KnowledgeEntryItem,
  resolutionSchema,
  type Resolution,
  knowledgeSearchResultSchema,
  type KnowledgeSearchResult,
  knowledgeGapTypeSchema,
  knowledgeMaintenanceResultSchema,
  type KnowledgeMaintenanceResult,
  knowledgeAskResultSchema,
  knowledgeGapsResultSchema,
  unifiedKnowledgeListResultSchema,
  resolutionListResultSchema,
  resolutionDensityScoreSchema,
  crossSessionStatsSchema,
  requirementDocListResultSchema,
  readKnowledgeFileResultSchema,
  knowledgeSyncStatusResultSchema,
  upsertKnowledgeResultSchema,
  knowledgeServiceSearchHitSchema,
  knowledgeHealthReportSchema,
  knowledgeFlywheelMetricsSchema,
  knowledgeAuditReportSchema,
  analystAccuracyReportSchema,
  injectContextResultSchema,
  matchResolutionsResultSchema,
  knowledgeExportQuerySchema,
  knowledgeGapParamsSchema,
  unifiedKnowledgeQuerySchema,
  knowledgeSearchQuerySchema,
  knowledgeFileQuerySchema,
  knowledgeServiceSearchQuerySchema,
  listKnowledgeEntriesQuerySchema,
  knowledgeEntryIdParamsSchema,
  knowledgeAskBodySchema,
  createUnifiedEntryBodySchema,
  readKnowledgeFileBodySchema,
  upsertKnowledgeBodySchema,
  createKnowledgeEntryBodySchema,
  updateKnowledgeEntryBodySchema,
  recordPatternBodySchema,
  recordIncidentBodySchema,
  recordTrendBodySchema,
  injectContextBodySchema,
  matchResolutionsBodySchema,
  recordOutcomeBodySchema,
  knowledgeLifecycleBodySchema,
  mergeKnowledgeBodySchema,
  unifiedKnowledgeListResponseSchema,
  knowledgeMaintenanceResponseSchema,
  knowledgeEntryResponseSchema,
} from '../knowledge.js';
import * as contractIndex from '../index.js';

/** harness KnowledgeEntry 全字段最小合法形状（FileKnowledgeStore 条目） */
const entryRow = {
  id: 'ke-1',
  type: 'guideline',
  title: '提交规范',
  content: '约定式提交',
  maturity: 'verified',
  layer: 'project',
  created: '2026-09-01T00:00:00.000Z',
  lastReferenced: '2026-09-02T00:00:00.000Z',
  contributors: ['manual'],
  projects: [],
  tags: ['process'],
  applicablePhases: [],
  sourceReferences: [{ source: 'manual:op-1', timestamp: '2026-09-01T00:00:00.000Z' }],
  referencedBy: [],
  executionResults: [],
  consumptionMode: 'reference',
  origin: 'human',
};

const unifiedRow: UnifiedKnowledgeEntry = {
  id: 'ke-1',
  title: '提交规范',
  content: '约定式提交',
  consumptionMode: 'reference',
  source: 'store',
  tags: ['process'],
  maturity: 'verified',
};

const entryItemRow: KnowledgeEntryItem = {
  id: 'ke-1',
  title: '提交规范',
  type: 'guideline',
  maturity: 'draft',
  created: '2026-09-01T00:00:00.000Z',
  tags: ['process'],
};

const resolutionRow: Resolution = {
  id: 'res-1',
  title: 'root 用户不能使用 --dangerously-skip-permissions',
  pattern: 'dangerously-skip-permissions.*root',
  errorClass: 'permission_error',
  layer: 'project',
  fix: '用非 root 用户运行',
  status: 'draft',
  verifyCount: 0,
  verifiedAt: '2026-09-01T00:00:00.000Z',
  sourceGoalId: 'goal-1',
  tags: ['permission'],
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z',
};

const searchHitRow: KnowledgeSearchResult = {
  type: 'resolution',
  id: 'res-1',
  title: 'root 用户不能使用 --dangerously-skip-permissions',
  snippet: '用非 root 用户运行',
  score: 4,
};

const maintenanceRow: KnowledgeMaintenanceResult = {
  dedupMerged: 2,
  qualityArchived: 1,
  freshnessUpdated: 0,
  contradictionsResolved: 3,
};

describe('knowledgeEntrySchema（harness KnowledgeEntry wire 重声明）', () => {
  it('接受全字段条目（含人工创建行的 source 字段 sourceReferences）', () => {
    expect(knowledgeEntrySchema.parse(entryRow)).toEqual(entryRow);
  });

  it('接受 Studio 扩展字段（unified-query 投影 applicableAgents/source）与可选字段', () => {
    const parsed = knowledgeEntrySchema.parse({
      ...entryRow,
      applicableAgents: ['executor'],
      source: 'store',
      decayAt: '2026-10-01T00:00:00.000Z',
      fullContentPath: '/x.md',
      skillId: 'sk-1',
    });
    expect(parsed.source).toBe('store');
    expect(parsed.applicableAgents).toEqual(['executor']);
  });

  it('缺核心字段即拒', () => {
    expect(() => knowledgeEntrySchema.parse({ ...entryRow, id: undefined })).toThrow();
    expect(() => knowledgeEntrySchema.parse({ ...entryRow, content: undefined })).toThrow();
  });
});

describe('手写 interface parity（z.infer 退化规避）', () => {
  it('parity：UnifiedKnowledgeEntry fixture 通过校验；实际下发的完整条目也过（passthrough）', () => {
    expect(unifiedKnowledgeEntrySchema.parse(unifiedRow)).toEqual(unifiedRow);
    // wire 实际 = 完整 KnowledgeEntry + 投影扩展，passthrough 放行
    const full = unifiedKnowledgeEntrySchema.parse({ ...entryRow, source: 'store' });
    expect(full.id).toBe('ke-1');
    expect(() => unifiedKnowledgeEntrySchema.parse({ ...unifiedRow, id: undefined })).toThrow();
    expect(() => unifiedKnowledgeEntrySchema.parse({ ...unifiedRow, title: undefined })).toThrow();
  });

  it('parity：KnowledgeEntryItem fixture 通过校验；完整条目 passthrough 放行', () => {
    expect(knowledgeEntryItemSchema.parse(entryItemRow)).toEqual(entryItemRow);
    expect(() => knowledgeEntryItemSchema.parse({ ...entryItemRow, id: undefined })).toThrow();
  });

  it('parity：Resolution fixture 通过校验；tags 双重编码串形态同样接受', () => {
    expect(resolutionSchema.parse(resolutionRow)).toEqual(resolutionRow);
    expect(resolutionSchema.parse({ ...resolutionRow, tags: '["a"]' }).tags).toBe('["a"]');
    expect(() => resolutionSchema.parse({ ...resolutionRow, id: undefined })).toThrow();
  });

  it('parity：KnowledgeSearchResult fixture 通过校验；缺 snippet/score 即拒', () => {
    expect(knowledgeSearchResultSchema.parse(searchHitRow)).toEqual(searchHitRow);
    expect(() => knowledgeSearchResultSchema.parse({ ...searchHitRow, snippet: undefined })).toThrow();
    expect(() => knowledgeSearchResultSchema.parse({ ...searchHitRow, score: undefined })).toThrow();
  });

  it('parity：KnowledgeMaintenanceResult fixture 通过校验；缺字段即拒', () => {
    expect(knowledgeMaintenanceResultSchema.parse(maintenanceRow)).toEqual(maintenanceRow);
    expect(() => knowledgeMaintenanceResultSchema.parse({ ...maintenanceRow, dedupMerged: undefined })).toThrow();
  });
});

describe('派生读 schema', () => {
  it('knowledgeGapTypeSchema 只收五类（原手写 400 词表）', () => {
    for (const t of ['preference', 'business_rule', 'environment', 'decision_chain', 'interaction']) {
      expect(knowledgeGapTypeSchema.parse(t)).toBe(t);
    }
    expect(() => knowledgeGapTypeSchema.parse('bogus')).toThrow();
  });

  it('ask/gaps/unified/resolutions/density/cross-session 结果形状', () => {
    expect(knowledgeAskResultSchema.parse({ answer: 'a', sources: [{ id: 'x', title: 't', type: 'guideline' }] }).sources).toHaveLength(1);
    expect(knowledgeGapsResultSchema.parse({ type: 'preference', data: [{ confidence: 0.9 }], total: 1 }).total).toBe(1);
    expect(unifiedKnowledgeListResultSchema.parse({ entries: [unifiedRow], total: 1 }).entries).toHaveLength(1);
    expect(resolutionListResultSchema.parse({ resolutions: [resolutionRow], total: 1, byStatus: { draft: 1 } }).byStatus.draft).toBe(1);
    expect(resolutionDensityScoreSchema.parse({ score: 50, total: 10, verified: 2, proven: 1, errorClasses: 3, layers: 2 }).score).toBe(50);
    expect(crossSessionStatsSchema.parse({ linkedToGoals: 1, unlinked: 2, topErrorClasses: [{ errorClass: 'permission_error', count: 3, avgVerifyCount: 1 }] }).unlinked).toBe(2);
  });

  it('files/sync/upsert 结果形状', () => {
    expect(requirementDocListResultSchema.parse({
      docs: [{ path: '/kb/p/需求.md', name: '需求.md', project: 'p', updatedAt: 't', isRequirement: true }],
      total: 1,
    }).total).toBe(1);
    expect(readKnowledgeFileResultSchema.parse({ content: 'c', path: '/x.md', size: 1, ext: '.md' }).ext).toBe('.md');
    expect(knowledgeSyncStatusResultSchema.parse({ trackedScopes: [], stale: [], unmonitored: [], healed: [] }).healed).toEqual([]);
    expect(upsertKnowledgeResultSchema.parse({ knowledgeStore: { action: 'created', entryId: 'ke-1' } }).knowledgeStore.action).toBe('created');
    expect(() => upsertKnowledgeResultSchema.parse({ knowledgeStore: { action: 'bogus', entryId: 'ke-1' } })).toThrow();
  });

  it('knowledge-service 派生读形状', () => {
    expect(knowledgeServiceSearchHitSchema.parse({ entry: entryRow, score: 0.9, highlights: ['h'] }).score).toBe(0.9);
    expect(knowledgeHealthReportSchema.parse({ score: 80, totalEntries: 10, staleEntries: 2, orphanEntries: 0, duplicateEntries: 0, timestamp: 't' }).score).toBe(80);
    expect(knowledgeFlywheelMetricsSchema.parse({ quality: 1, hitRate: 0, improvement: 0, freshness: 1, timestamp: 't', source: 'insufficient-data' }).source).toBe('insufficient-data');
    expect(knowledgeAuditReportSchema.parse({
      findings: [], trend: 'stable', timestamp: 't',
      eventCounts: { windowDays: 30, consumption: 0, outcomeSuccess: 0, outcomeFailure: 0, extraction: 0, source: 'insufficient-data' },
      entries: { total: 0, byMaturity: {}, source: 'store' },
      topReferenced: [],
      extractionActivity: { count: 0, totalTokens: 0, lastAt: null, source: 'events' },
    }).entries.source).toBe('store');
    expect(analystAccuracyReportSchema.parse({ available: false, reason: 'no data', timestamp: 't' }).available).toBe(false);
    expect(injectContextResultSchema.parse({ context: 'c', injectedIds: ['a'] }).injectedIds).toEqual(['a']);
    expect(matchResolutionsResultSchema.parse({ matched: true, resolutions: [resolutionRow] }).matched).toBe(true);
  });
});

describe('请求 schema 边界（原手写 400 guard 收进 zod）', () => {
  it('query：q/path/filePath/entryId 等必填项缺失即 400', () => {
    expect(() => knowledgeSearchQuerySchema.parse({})).toThrow();
    expect(knowledgeSearchQuerySchema.parse({ q: 'x' }).q).toBe('x');
    expect(() => knowledgeFileQuerySchema.parse({})).toThrow();
    expect(() => knowledgeServiceSearchQuerySchema.parse({})).toThrow();
    expect(knowledgeExportQuerySchema.parse({}).format).toBeUndefined();
    expect(knowledgeGapParamsSchema.parse({ type: 'preference' }).type).toBe('preference');
    expect(() => knowledgeGapParamsSchema.parse({ type: 'bogus' })).toThrow();
    expect(unifiedKnowledgeQuerySchema.parse({ consumptionMode: 'rule', offset: '20' }).offset).toBe('20');
    expect(listKnowledgeEntriesQuerySchema.parse({ maturity: 'draft' }).maturity).toBe('draft');
    expect(() => knowledgeEntryIdParamsSchema.parse({ id: '' })).toThrow();
  });

  it('body：必填字段缺失即 400', () => {
    expect(() => knowledgeAskBodySchema.parse({})).toThrow();
    expect(knowledgeAskBodySchema.parse({ question: 'q' }).question).toBe('q');
    expect(() => createUnifiedEntryBodySchema.parse({ type: 't', title: 't' })).toThrow();
    expect(createUnifiedEntryBodySchema.parse({ type: 't', title: 't', content: 'c', consumptionMode: 'rule' }).consumptionMode).toBe('rule');
    expect(() => readKnowledgeFileBodySchema.parse({})).toThrow();
    expect(() => upsertKnowledgeBodySchema.parse({ scope: 's' })).toThrow();
    expect(() => createKnowledgeEntryBodySchema.parse({ id: 'x' })).toThrow();
    // passthrough：完整条目的其余字段放行（service 消费整个 body）
    const full = createKnowledgeEntryBodySchema.parse({ ...entryRow });
    expect((full as Record<string, unknown>).maturity).toBe('verified');
    expect(updateKnowledgeEntryBodySchema.parse({ title: 'new' }).title).toBe('new');
    expect(() => recordPatternBodySchema.parse({ type: 't' })).toThrow();
    expect(() => recordIncidentBodySchema.parse({ title: 't', content: 'c' })).toThrow();
    expect(() => recordTrendBodySchema.parse({ title: 't', content: 'c' })).toThrow();
    expect(() => injectContextBodySchema.parse({})).toThrow();
    expect(() => matchResolutionsBodySchema.parse({})).toThrow();
    expect(() => recordOutcomeBodySchema.parse({ executionId: 'e', agentType: 'a' })).toThrow(); // success 必填
    expect(recordOutcomeBodySchema.parse({ executionId: 'e', agentType: 'a', success: false }).success).toBe(false);
    expect(() => knowledgeLifecycleBodySchema.parse({})).toThrow();
    expect(() => mergeKnowledgeBodySchema.parse({ sourceId: 'a' })).toThrow();
  });
});

describe('响应壳', () => {
  it('unified 列表 / maintenance / 单条目响应 = { data } 壳', () => {
    expect(unifiedKnowledgeListResponseSchema.parse({ data: { entries: [unifiedRow], total: 1 } }).data.total).toBe(1);
    expect(knowledgeMaintenanceResponseSchema.parse({ data: maintenanceRow }).data.dedupMerged).toBe(2);
    expect(knowledgeEntryResponseSchema.parse({ data: entryRow }).data.id).toBe('ke-1');
  });
});

describe('index.ts 出口', () => {
  it('knowledge 域 schema 经 index 导出', () => {
    expect(contractIndex.knowledgeEntrySchema).toBeDefined();
    expect(contractIndex.knowledgeSearchQuerySchema).toBeDefined();
    expect(contractIndex.knowledgeMaintenanceResponseSchema).toBeDefined();
  });
});
