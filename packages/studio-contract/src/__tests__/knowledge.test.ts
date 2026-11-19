/**
 * knowledge 域契约测试：实体/请求/响应 schema 的接受-拒绝边界 + 响应壳。
 * schema 即正本（手写 interface 已退役为 z.infer 同源 + 编译期锚定）；
 * wire 参照 = knowledge-service.ts / knowledge-types.ts /
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
  knowledgeGapsResultSchema,
  unifiedKnowledgeListResultSchema,
  resolutionListResultSchema,
  knowledgeSyncStatusResultSchema,
  upsertKnowledgeResultSchema,
  knowledgeGapParamsSchema,
  unifiedKnowledgeQuerySchema,
  knowledgeSearchQuerySchema,
  listKnowledgeEntriesQuerySchema,
  createUnifiedEntryBodySchema,
  upsertKnowledgeBodySchema,
  knowledgeLifecycleBodySchema,
  unifiedKnowledgeListResponseSchema,
  knowledgeMaintenanceResponseSchema,
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

describe('knowledgeEntrySchema（harness KnowledgeEntry wire，executionResults 字段级单向锚定）', () => {
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

describe('实体 wire 边界', () => {
  it('UnifiedKnowledgeEntry：完整条目 passthrough 放行；缺 id/title 即拒', () => {
    const full = unifiedKnowledgeEntrySchema.parse({ ...entryRow, source: 'store' });
    expect(full.id).toBe('ke-1');
    expect(() => unifiedKnowledgeEntrySchema.parse({ ...unifiedRow, id: undefined })).toThrow();
    expect(() => unifiedKnowledgeEntrySchema.parse({ ...unifiedRow, title: undefined })).toThrow();
  });

  it('KnowledgeEntryItem：完整条目 passthrough 放行；缺 id 即拒', () => {
    expect(knowledgeEntryItemSchema.parse(entryItemRow)).toEqual(entryItemRow);
    expect(() => knowledgeEntryItemSchema.parse({ ...entryItemRow, id: undefined })).toThrow();
  });

  it('Resolution：tags 双重编码串形态同样接受（历史行容错）；缺 id 即拒', () => {
    expect(resolutionSchema.parse(resolutionRow)).toEqual(resolutionRow);
    expect(resolutionSchema.parse({ ...resolutionRow, tags: '["a"]' }).tags).toBe('["a"]');
    expect(() => resolutionSchema.parse({ ...resolutionRow, id: undefined })).toThrow();
  });

  it('KnowledgeSearchResult：缺 snippet/score 即拒', () => {
    expect(knowledgeSearchResultSchema.parse(searchHitRow)).toEqual(searchHitRow);
    expect(() => knowledgeSearchResultSchema.parse({ ...searchHitRow, snippet: undefined })).toThrow();
    expect(() => knowledgeSearchResultSchema.parse({ ...searchHitRow, score: undefined })).toThrow();
  });

  it('KnowledgeMaintenanceResult：缺字段即拒', () => {
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

  it('gaps/unified/resolutions 结果形状', () => {
    expect(knowledgeGapsResultSchema.parse({ type: 'preference', data: [{ confidence: 0.9 }], total: 1 }).total).toBe(1);
    expect(unifiedKnowledgeListResultSchema.parse({ entries: [unifiedRow], total: 1 }).entries).toHaveLength(1);
    expect(resolutionListResultSchema.parse({ resolutions: [resolutionRow], total: 1, byStatus: { draft: 1 } }).byStatus.draft).toBe(1);
  });

  it('sync/upsert 结果形状', () => {
    expect(knowledgeSyncStatusResultSchema.parse({ trackedScopes: [], stale: [], unmonitored: [], healed: [] }).healed).toEqual([]);
    expect(upsertKnowledgeResultSchema.parse({ knowledgeStore: { action: 'created', entryId: 'ke-1' } }).knowledgeStore.action).toBe('created');
    expect(() => upsertKnowledgeResultSchema.parse({ knowledgeStore: { action: 'bogus', entryId: 'ke-1' } })).toThrow();
  });
});

describe('请求 schema 边界（原手写 400 guard 收进 zod）', () => {
  it('query：q 等必填项缺失即 400', () => {
    expect(() => knowledgeSearchQuerySchema.parse({})).toThrow();
    expect(knowledgeSearchQuerySchema.parse({ q: 'x' }).q).toBe('x');
    expect(knowledgeGapParamsSchema.parse({ type: 'preference' }).type).toBe('preference');
    expect(() => knowledgeGapParamsSchema.parse({ type: 'bogus' })).toThrow();
    expect(unifiedKnowledgeQuerySchema.parse({ consumptionMode: 'rule', offset: '20' }).offset).toBe('20');
    expect(listKnowledgeEntriesQuerySchema.parse({ maturity: 'draft' }).maturity).toBe('draft');
  });

  it('body：必填字段缺失即 400', () => {
    expect(() => createUnifiedEntryBodySchema.parse({ type: 't', title: 't' })).toThrow();
    expect(createUnifiedEntryBodySchema.parse({ type: 't', title: 't', content: 'c', consumptionMode: 'rule' }).consumptionMode).toBe('rule');
    expect(() => upsertKnowledgeBodySchema.parse({ scope: 's' })).toThrow();
    expect(() => knowledgeLifecycleBodySchema.parse({})).toThrow();
  });
});

describe('响应壳', () => {
  it('unified 列表 / maintenance 响应 = { data } 壳', () => {
    expect(unifiedKnowledgeListResponseSchema.parse({ data: { entries: [unifiedRow], total: 1 } }).data.total).toBe(1);
    expect(knowledgeMaintenanceResponseSchema.parse({ data: maintenanceRow }).data.dedupMerged).toBe(2);
  });
});

describe('index.ts 出口', () => {
  it('knowledge 域 schema 经 index 导出', () => {
    expect(contractIndex.knowledgeEntrySchema).toBeDefined();
    expect(contractIndex.knowledgeSearchQuerySchema).toBeDefined();
    expect(contractIndex.knowledgeMaintenanceResponseSchema).toBeDefined();
  });
});
