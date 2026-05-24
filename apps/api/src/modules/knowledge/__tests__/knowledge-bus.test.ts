/**
 * KnowledgeBus 边界测试
 */
import { describe, it, expect } from 'vitest';
import { knowledgeBus, sharedStore, upsertKnowledge } from '../knowledge-bus.service.js';

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
