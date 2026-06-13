/**
 * Tests for extract-historical-sdd.ts — quality filter logic
 */
import { describe, it, expect } from 'vitest';

// Inline quality filter logic for testing (script is CLI, not importable)
function isQualityEntry(firstLine: string, size: number): boolean {
  if (size < 50) return false;
  if (firstLine.includes('[DEPRECATED]')) return false;
  return true;
}

function groupByPrefix(files: string[]): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  for (const f of files) {
    const prefix = f.split('_')[0] || 'other';
    if (!groups[prefix]) groups[prefix] = [];
    groups[prefix].push(f);
  }
  return groups;
}

describe('extract-historical-sdd', () => {
  describe('quality filter', () => {
    it('rejects files < 50 bytes', () => {
      expect(isQualityEntry('# Title', 30)).toBe(false);
    });

    it('rejects deprecated entries', () => {
      expect(isQualityEntry('[DEPRECATED] old thing', 100)).toBe(false);
    });

    it('accepts normal entries', () => {
      expect(isQualityEntry('# Project Architecture', 200)).toBe(true);
    });
  });

  describe('grouping', () => {
    it('groups by filename prefix', () => {
      const result = groupByPrefix(['project_a.md', 'project_b.md', 'feedback_c.md']);
      expect(result['project']).toHaveLength(2);
      expect(result['feedback']).toHaveLength(1);
    });

    it('handles single-group case', () => {
      const result = groupByPrefix(['architecture_x.md']);
      expect(result['architecture']).toHaveLength(1);
    });
  });
});
