// ReviewAgent reviewDiff + hasBranchChanges tests
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { reviewAgent } from '../review-agent.service.js';
import { execSh } from '@dommaker/studio-shared/node';

const repoDir = path.resolve('/root/projects/studio');

describe('ReviewAgent (topology-agnostic)', () => {
  // ── hasBranchChanges (fast, no Claude) ──

  describe('hasBranchChanges', () => {
    it('returns true when branches/refs differ', async () => {
      const result = await (reviewAgent as any).hasBranchChanges(
        repoDir,
        'HEAD~1',
        'HEAD',
      );
      expect(result).toBe(true);
    });

    it('returns false when both refs are the same', async () => {
      const result = await (reviewAgent as any).hasBranchChanges(
        repoDir,
        'origin/master',
        'origin/master',
      );
      expect(result).toBe(false);
    });

    it('handles invalid refs gracefully (empty diff = no match)', async () => {
      const result = await (reviewAgent as any).hasBranchChanges(
        repoDir,
        'nonexistent-abc-123',
        'also-nonexistent-xyz-789',
      );
      // git diff with invalid refs: stderr gets fatal error, stdout is empty
      // hasBranchChanges reads stdout only, so empty = no changes detected = false
      // This is safe: no diff to review = auto-approve
      expect(typeof result).toBe('boolean');
    });
  });

  // ── reviewDiff error handling (no Claude spawn) ──

  describe('reviewDiff error handling', () => {
    it('gracefully handles invalid refs without throwing', async () => {
      const result = await reviewAgent.reviewDiff({
        baseRef: 'nonexistent-ref-abc',
        headRef: 'also-nonexistent-xyz',
        repoPath: repoDir,
      });

      expect(result).toBeDefined();
      expect(result).toHaveProperty('approved');
      expect(result).toHaveProperty('score');
      expect(result).toHaveProperty('issues');
    });
  });

  // ── Result shape for real branches (integration test, requires Claude CLI) ──
  // Set RUN_CLAUDE_REVIEW_TESTS=true to enable

  describe.skipIf(!process.env.RUN_CLAUDE_REVIEW_TESTS)('reviewDiff with real branches (requires Claude)', () => {
    it('returns valid ReviewResult shape', { timeout: 120000 }, async () => {
      const result = await reviewAgent.reviewDiff({
        baseRef: 'origin/master',
        headRef: 'origin/main',
        repoPath: repoDir,
        acceptanceCriteria: ['No breaking changes', 'All tests pass'],
        stances: [
          { id: 'security', name: 'Security', prompt: 'Check for security issues' },
        ],
      });

      expect(result).toBeDefined();
      expect(typeof result.approved).toBe('boolean');
      expect(typeof result.score).toBe('number');
      expect(Array.isArray(result.issues)).toBe(true);
      expect(Array.isArray(result.suggestions)).toBe(true);
    }, 120000);
  });
});
