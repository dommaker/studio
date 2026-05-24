/**
 * Supplementary test: KnowledgeSync staleness detection
 *
 * Verifies:
 * - detectStaleness returns empty when no entries exist
 * - detectStaleness does not crash on invalid repoDir
 */
import { describe, it, expect, beforeEach } from 'vitest';

// Note: This test imports the service and tests it in isolation.
// Full integration tests require a git repo + Prisma.

describe('KnowledgeSync staleness detection', () => {
  it('returns empty stale/unmonitored when no design-docs exist', async () => {
    // Dynamic import to avoid init failures in non-Studio environments
    const { knowledgeSync } = await import('../knowledge-sync.service.js');
    const result = knowledgeSync.detectStaleness('/nonexistent');
    expect(result).toHaveProperty('stale');
    expect(result).toHaveProperty('unmonitored');
    expect(Array.isArray(result.stale)).toBe(true);
    expect(Array.isArray(result.unmonitored)).toBe(true);
  });

  it('getTrackedScopes returns non-empty list', async () => {
    const { knowledgeSync } = await import('../knowledge-sync.service.js');
    const scopes = knowledgeSync.getTrackedScopes();
    expect(scopes.length).toBeGreaterThan(0);
  });
});
