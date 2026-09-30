/**
 * knowledge-injector 单元测试 — studio 本地注入策略（harness KnowledgeInjector 收口承接）
 *
 * 覆盖：预算裁剪（全文 → 摘要降级 → 丢弃）、exclude 去重、已排除条目摘要降级
 * 开关、外部来源标记透传（EXTERNAL_SOURCE_MARKER 前缀进全文与摘要）。
 * query 用桩对象（注入策略只消费 query.query()）；token 尺子用 harness
 * estimateTokens 真值动态计算预算，避免硬编码字符数随格式微调漂移。
 */
import { describe, it, expect, vi } from 'vitest';
import { estimateTokens } from '@dommaker/harness';
import type { KnowledgeEntry, KnowledgeQuery } from '@dommaker/harness';
import { KnowledgeInjector, EXTERNAL_SOURCE_MARKER } from '../knowledge-injector.js';

function makeEntry(overrides: Partial<KnowledgeEntry> & { id: string }): KnowledgeEntry {
  const now = new Date().toISOString();
  return {
    type: 'guideline',
    title: `title-${overrides.id}`,
    content: `content of ${overrides.id}`,
    maturity: 'active',
    layer: 'project',
    created: now,
    lastReferenced: now,
    contributors: [],
    projects: [],
    tags: [],
    applicablePhases: [],
    sourceReferences: [],
    referencedBy: [],
    executionResults: [],
    consumptionMode: 'signal',
    origin: 'system',
    ...overrides,
  };
}

function makeInjector(entries: KnowledgeEntry[]): KnowledgeInjector {
  const query = {
    query: vi.fn(() => ({ entries, tokensUsed: 0, truncated: false, fromCache: false })),
  } as unknown as KnowledgeQuery;
  return new KnowledgeInjector(query);
}

describe('KnowledgeInjector (studio local)', () => {
  it('预算充足：全文注入，metadata 带 entryId/maturity/origin', () => {
    const entry = makeEntry({ id: 'e1', maturity: 'verified', tags: ['t1'] });
    const injector = makeInjector([entry]);
    const budget = estimateTokens(injector.formatEntry(entry)) + 10;

    const result = injector.inject({ budget });

    expect(result.entriesIncluded).toBe(1);
    expect(result.entriesExcluded).toBe(0);
    expect(result.entriesSummarized).toBe(0);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].id).toBe('knowledge-e1');
    expect(result.sources[0].type).toBe('knowledge');
    expect(result.sources[0].content).toContain('## [GUIDELINE] title-e1');
    expect(result.sources[0].metadata).toEqual({ entryId: 'e1', maturity: 'verified', origin: 'system' });
    expect(result.tokensUsed).toBeLessThanOrEqual(budget);
  });

  it('预算裁剪：全文放不下的条目降级为摘要，摘要也放不下则丢弃', () => {
    const e1 = makeEntry({ id: 'e1' });
    const e2 = makeEntry({ id: 'e2' });
    const injector = makeInjector([e1, e2]);
    const full1 = estimateTokens(injector.formatEntry(e1));
    const summary2 = estimateTokens(injector.formatEntrySummary(e2));

    // 预算恰够 e1 全文 + e2 摘要，不够 e2 全文
    const result = injector.inject({ budget: full1 + summary2 });

    expect(result.entriesIncluded).toBe(1);
    expect(result.entriesSummarized).toBe(1);
    expect(result.sources.map(s => s.id)).toEqual(['knowledge-e1', 'knowledge-summary-e2']);
    expect(result.sources[1].metadata).toEqual({ entryId: 'e2', isSummary: true, origin: 'system' });
    expect(result.tokensUsed).toBeLessThanOrEqual(full1 + summary2);

    // 预算连 e1 摘要都不够 → 全部丢弃
    const starved = makeInjector([e1]).inject({ budget: 1 });
    expect(starved.sources).toHaveLength(0);
    expect(starved.entriesIncluded).toBe(0);
    expect(starved.entriesSummarized).toBe(0);
  });

  it('exclude 去重：已排除条目不注入全文，缺省降级为摘要', () => {
    const e1 = makeEntry({ id: 'e1' });
    const injector = makeInjector([e1]);
    const budget = estimateTokens(injector.formatEntry(e1)) + 100;

    const result = injector.inject({ budget, exclude: ['e1'] });

    expect(result.entriesIncluded).toBe(0);
    expect(result.entriesExcluded).toBe(1);
    expect(result.entriesSummarized).toBe(1);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].id).toBe('knowledge-summary-e1');
    expect(result.sources[0].metadata?.isSummary).toBe(true);
  });

  it('exclude + injectSummaryForExcluded=false：已排除条目完全不注入', () => {
    const e1 = makeEntry({ id: 'e1' });
    const injector = makeInjector([e1]);
    const budget = estimateTokens(injector.formatEntry(e1)) + 100;

    const result = injector.inject({ budget, exclude: ['e1'], injectSummaryForExcluded: false });

    expect(result.entriesExcluded).toBe(1);
    expect(result.entriesSummarized).toBe(0);
    expect(result.sources).toHaveLength(0);
  });

  it('外部来源标记透传：external origin 条目全文与摘要均带 EXTERNAL_SOURCE_MARKER 前缀', () => {
    const entry = makeEntry({ id: 'ext1', origin: 'external' });
    const injector = makeInjector([entry]);

    expect(injector.formatEntry(entry).startsWith(EXTERNAL_SOURCE_MARKER)).toBe(true);
    expect(injector.formatEntrySummary(entry).startsWith(`${EXTERNAL_SOURCE_MARKER} `)).toBe(true);

    // system origin 不带标记
    const sys = makeEntry({ id: 'sys1', origin: 'system' });
    expect(injector.formatEntry(sys)).not.toContain(EXTERNAL_SOURCE_MARKER);
    expect(injector.formatEntrySummary(sys)).not.toContain(EXTERNAL_SOURCE_MARKER);

    // 注入产物同样透传标记
    const budget = estimateTokens(injector.formatEntry(entry)) + 10;
    const result = injector.inject({ budget });
    expect(result.sources[0].content.startsWith(EXTERNAL_SOURCE_MARKER)).toBe(true);
    expect(result.sources[0].metadata?.origin).toBe('external');
  });

  it('长内容摘要截断 100 字符并补省略号', () => {
    const long = makeEntry({ id: 'long1', content: 'x'.repeat(150) });
    const injector = makeInjector([long]);
    const summary = injector.formatEntrySummary(long);
    expect(summary).toContain('x'.repeat(100) + '...');
  });
});
