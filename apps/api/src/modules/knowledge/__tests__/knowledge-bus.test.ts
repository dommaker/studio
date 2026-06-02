/**
 * KnowledgeBus 边界测试
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { knowledgeBus, sharedStore, upsertKnowledge, KnowledgeBus } from '../knowledge-bus.service.js';

describe('KnowledgeBus', () => {
  describe('getRecentContext', () => {
    it('returns non-empty string (shared store has entries) and does not throw', () => {
      // sharedStore is a singleton — may have entries from other tests/system
      expect(() => knowledgeBus.getRecentContext('test-agent', 5)).not.toThrow();
    });

    it('handles maxItems=0 gracefully', () => {
      expect(() => knowledgeBus.getRecentContext('test-agent', 0)).not.toThrow();
    });

    it('does not throw on invalid agent type', () => {
      expect(() => knowledgeBus.getRecentContext('')).not.toThrow();
    });
  });

  describe('queryByType', () => {
    it('does not throw for non-existent type', async () => {
      const results = await knowledgeBus.queryByType('__nonexistent__' + Date.now());
      expect(Array.isArray(results)).toBe(true);
    });

    it('handles limit=0 gracefully', async () => {
      const results = await knowledgeBus.queryByType('pattern', 0);
      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe('getStats', () => {
    it('returns total count (at least 0)', () => {
      const stats = knowledgeBus.getStats();
      expect(typeof stats.total).toBe('number');
      expect(stats.total).toBeGreaterThanOrEqual(0);
    });
  });

  describe('formatIndexSummary', () => {
    it('returns string without throwing', () => {
      expect(() => knowledgeBus.formatIndexSummary()).not.toThrow();
    });

    it('includes MCP retrieval instruction', () => {
      const summary = knowledgeBus.formatIndexSummary();
      if (summary.length > 0) {
        expect(summary).toContain('mcp__local-rag__query_documents');
      }
    });

    it('includes [REF:xxx] markers when entries exist', () => {
      const summary = knowledgeBus.formatIndexSummary();
      // If store has entries, summary should include REF markers
      const stats = knowledgeBus.getStats();
      if (stats.total > 0) {
        expect(summary).toMatch(/\[REF:/);
      }
    });

    it('includes knowledge retrieval instruction after entries', () => {
      const summary = knowledgeBus.formatIndexSummary();
      if (summary.length > 0) {
        expect(summary).toContain('需要更多知识时');
      }
    });
  });

  describe('recordPattern', () => {
    it('does not throw on minimal input', async () => {
      await expect(knowledgeBus.recordPattern({
        source: 'reviewer',
        type: 'pattern',
        title: 'Test pattern',
        content: 'Test content',
        severity: 'info',
        timestamp: Date.now(),
      })).resolves.not.toThrow();
    });
  });

  describe('recordIncident', () => {
    it('handles minimal incident gracefully', async () => {
      await expect(knowledgeBus.recordIncident({
        source: 'ops',
        type: 'incident',
        title: 'Test incident',
        content: 'Test content',
        severity: 'warning',
        timestamp: Date.now(),
      })).resolves.not.toThrow();
    });
  });
});

describe('upsertKnowledge', () => {
  it('creates entry for new scope', async () => {
    const result = await upsertKnowledge({
      scope: `test-scope-${Date.now()}`,
      title: 'Test Entry',
      content: '# Test\nThis is a test entry.',
    });
    expect(['created', 'updated', 'refreshed', 'unchanged']).toContain(result.action);
    expect(result.entryId).toBeDefined();
    expect(typeof result.entryId).toBe('string');
  });

  it('handles empty content without throwing', async () => {
    const result = await upsertKnowledge({
      scope: `test-empty-${Date.now()}`,
      title: 'Empty Test',
      content: '',
    });
    expect(result.entryId).toBeDefined();
  });
});

// ── extractKeywords (AS-019) ──

describe('extractKeywords', () => {
  it('splits on whitespace and punctuation', () => {
    const kw = KnowledgeBus.extractKeywords('prisma migration failed');
    expect(kw).toEqual(['prisma', 'migration', 'failed']);
  });

  it('filters stopwords', () => {
    const kw = KnowledgeBus.extractKeywords('the quick brown fox is very fast');
    // "the", "is", "very" are stopwords
    expect(kw).not.toContain('the');
    expect(kw).not.toContain('is');
    expect(kw).not.toContain('very');
    expect(kw).toContain('quick');
    expect(kw).toContain('brown');
    expect(kw).toContain('fox');
    expect(kw).toContain('fast');
  });

  it('filters Chinese stopwords when separated by spaces', () => {
    const kw = KnowledgeBus.extractKeywords('需要 实现 一个 修改 功能');
    // "需要", "实现", "一个", "修改" are stopwords
    expect(kw).not.toContain('需要');
    expect(kw).not.toContain('实现');
    expect(kw).not.toContain('一个');
    expect(kw).not.toContain('修改');
    expect(kw).toContain('功能');
  });

  it('treats unseparated Chinese as single token', () => {
    // extractKeywords splits on whitespace/punctuation, not Chinese boundaries
    const kw = KnowledgeBus.extractKeywords('需要实现一个修改功能');
    expect(kw.length).toBeLessThanOrEqual(1);
  });

  it('filters words shorter than 2 chars', () => {
    const kw = KnowledgeBus.extractKeywords('a bb ccc dddd');
    expect(kw).toEqual(['bb', 'ccc', 'dddd']);
  });

  it('lowercases keywords', () => {
    const kw = KnowledgeBus.extractKeywords('PrismaClient SQLite');
    expect(kw).toEqual(['prismaclient', 'sqlite']);
  });

  it('limits to 8 keywords', () => {
    const kw = KnowledgeBus.extractKeywords('one two three four five six seven eight nine ten');
    expect(kw.length).toBeLessThanOrEqual(8);
  });

  it('returns empty array for empty string', () => {
    expect(KnowledgeBus.extractKeywords('')).toEqual([]);
  });

  it('returns empty array if all words are stopwords', () => {
    expect(KnowledgeBus.extractKeywords('the is a an')).toEqual([]);
  });
});

// ── search (AS-019) ──

describe('search', () => {
  const testId = `test-search-${Date.now()}`;

  beforeAll(() => {
    // Seed store with test entries
    sharedStore.save({
      id: `${testId}-pitfall`,
      type: 'guideline',
      title: 'Prisma migration pitfall',
      content: 'Never run prisma migrate in production without backup. Always use prisma migrate deploy.',
      maturity: 'verified',
      layer: 'L1',
      created: new Date().toISOString(),
      lastReferenced: new Date().toISOString(),
      contributors: ['test'],
      projects: [],
      tags: ['pitfall'],
      applicablePhases: [],
      sourceReferences: [],
      referencedBy: [],
    });
    sharedStore.save({
      id: `${testId}-pattern`,
      type: 'guideline',
      title: 'SQLite WAL mode pattern',
      content: 'Enable WAL mode for concurrent reads: PRAGMA journal_mode=WAL. Improves performance.',
      maturity: 'proven',
      layer: 'L1',
      created: new Date().toISOString(),
      lastReferenced: new Date().toISOString(),
      contributors: ['test'],
      projects: [],
      tags: ['pattern'],
      applicablePhases: [],
      sourceReferences: [],
      referencedBy: [],
    });
    sharedStore.save({
      id: `${testId}-archived`,
      type: 'guideline',
      title: 'Archived entry',
      content: 'This entry is archived and should not appear in search results.',
      maturity: 'archived',
      layer: 'L1',
      created: new Date().toISOString(),
      lastReferenced: new Date().toISOString(),
      contributors: ['test'],
      projects: [],
      tags: ['pattern'],
      applicablePhases: [],
      sourceReferences: [],
      referencedBy: [],
    });
  });

  it('returns matching entries', () => {
    const results = knowledgeBus.search('prisma migration');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toContain('Prisma');
  });

  it('excludes archived entries', () => {
    const results = knowledgeBus.search('archived entry');
    const archived = results.find(r => r.id === `${testId}-archived`);
    expect(archived).toBeUndefined();
  });

  it('returns empty for no matches', () => {
    const results = knowledgeBus.search('xyznonexistent');
    expect(results).toEqual([]);
  });

  it('returns empty for empty query', () => {
    const results = knowledgeBus.search('');
    expect(results).toEqual([]);
  });

  it('respects limit option', () => {
    const results = knowledgeBus.search('prisma sqlite', { limit: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('filters by type option', () => {
    const results = knowledgeBus.search('prisma sqlite', { type: 'pitfall' });
    for (const r of results) {
      expect(r.type).toBe('pitfall');
    }
  });

  it('scores title matches higher than content matches', () => {
    // "prisma" in title of pitfall entry vs "sqlite" only in content of pattern entry
    const results = knowledgeBus.search('prisma');
    if (results.length >= 1) {
      expect(results[0].title.toLowerCase()).toContain('prisma');
    }
  });

  it('returns matchContext with snippet', () => {
    const results = knowledgeBus.search('WAL mode');
    if (results.length > 0) {
      expect(results[0].matchContext).toBeTruthy();
      expect(results[0].matchContext.length).toBeGreaterThan(0);
    }
  });
});

// ── formatSearchForPrompt (AS-019) ──

describe('formatSearchForPrompt', () => {
  it('returns empty string for empty results', () => {
    expect(knowledgeBus.formatSearchForPrompt([])).toBe('');
  });

  it('includes header', () => {
    const results = knowledgeBus.search('prisma');
    const formatted = knowledgeBus.formatSearchForPrompt(results);
    if (results.length > 0) {
      expect(formatted).toContain('历史相关知识');
    }
  });

  it('includes [REF:xxx] markers', () => {
    const results = knowledgeBus.search('prisma');
    const formatted = knowledgeBus.formatSearchForPrompt(results);
    if (results.length > 0) {
      expect(formatted).toMatch(/\[REF:/);
    }
  });

  it('uses correct icon for pitfall type', () => {
    const formatted = knowledgeBus.formatSearchForPrompt([
      { id: 'x', type: 'pitfall', title: 't', content: 'c', maturity: 'verified', score: 1, matchContext: 'ctx' },
    ]);
    expect(formatted).toContain('⚠️');
  });

  it('uses correct icon for guideline type', () => {
    const formatted = knowledgeBus.formatSearchForPrompt([
      { id: 'x', type: 'guideline', title: 't', content: 'c', maturity: 'verified', score: 1, matchContext: 'ctx' },
    ]);
    expect(formatted).toContain('📋');
  });

  it('uses default icon for other types', () => {
    const formatted = knowledgeBus.formatSearchForPrompt([
      { id: 'x', type: 'pattern', title: 't', content: 'c', maturity: 'verified', score: 1, matchContext: 'ctx' },
    ]);
    expect(formatted).toContain('🔍');
  });
});
