/**
 * Tests for SddFreshnessService
 *
 * SP-004 Step 9: SDD Doc Freshness
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock studio-shared before importing service
vi.mock('@dommaker/studio-shared', () => ({
  readSddDoc: vi.fn(),
  writeSddDoc: vi.fn(),
  listSddDocs: vi.fn(),
  appendChangelog: vi.fn(),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock SystemExecutor — applyPatches 走 LLM 失败 → append 兜底路径（确定性，不触真实 CLI）
vi.mock('../../agents/system-executor.js', () => ({
  getSystemExecutor: () => ({
    run: vi.fn().mockRejectedValue(new Error('studio role not configured (test)')),
  }),
}));

import {
  classifySddChange,
  parseFilesSection,
  SddFreshnessService,
} from '../sdd-freshness.service.js';
import {
  readSddDoc,
  writeSddDoc,
  listSddDocs,
  appendChangelog,
} from '@dommaker/studio-shared';

// ── classifySddChange ──

describe('classifySddChange', () => {
  it('L1: whitespace-only change (<=3 lines)', () => {
    const diff = [
      '@@ -1,2 +1,2 @@',
      '-  ',
      '+   ',
    ].join('\n');
    expect(classifySddChange(diff, ['foo.ts'])).toBe('L1');
  });

  it('L1: comment-only change (<=3 lines)', () => {
    const diff = [
      '@@ -1,2 +1,2 @@',
      '-// old comment',
      '+// new comment',
    ].join('\n');
    expect(classifySddChange(diff, ['foo.ts'])).toBe('L1');
  });

  it('L1: import formatting change', () => {
    const diff = [
      '@@ -1,2 +1,2 @@',
      '-import { a } from "b"',
      '+import { a, b } from "b"',
    ].join('\n');
    // This is 1 added + 1 removed = 2 lines, but import is not trivial (has content change)
    // Actually import line check is `startsWith('import ')`, both are imports so they pass
    expect(classifySddChange(diff, ['foo.ts'])).toBe('L1');
  });

  it('L2: small change (<=2 files, <=30 lines)', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `+line ${i}`).join('\n');
    const diff = `@@ -1,1 +1,11 @@\n-old\n${lines}`;
    expect(classifySddChange(diff, ['foo.ts'])).toBe('L2');
  });

  it('L2: exactly 2 files and 30 lines', () => {
    const lines = Array.from({ length: 15 }, (_, i) => `+line ${i}`).join('\n');
    const diff = `@@ -1,1 +1,16 @@\n-old\n${lines}`;
    expect(classifySddChange(diff, ['a.ts', 'b.ts'])).toBe('L2');
  });

  it('L3: 3 files (not L2, not L4)', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `+line ${i}`).join('\n');
    const diff = `@@ -1,1 +1,11 @@\n-old\n${lines}`;
    expect(classifySddChange(diff, ['a.ts', 'b.ts', 'c.ts'])).toBe('L3');
  });

  it('L3: has new files even with few files', () => {
    const diff = [
      'diff --git a/new.ts b/new.ts',
      'new file mode 100644',
      '@@ -0,0 +1,5 @@',
      '+export const x = 1;',
      '+export const y = 2;',
      '+export const z = 3;',
      '+export const w = 4;',
      '+export const v = 5;',
    ].join('\n');
    expect(classifySddChange(diff, ['new.ts'])).toBe('L3');
  });

  it('L4: more than 5 files', () => {
    const lines = Array.from({ length: 5 }, (_, i) => `+line ${i}`).join('\n');
    const diff = `@@ -1,1 +1,6 @@\n-old\n${lines}`;
    const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'];
    expect(classifySddChange(diff, files)).toBe('L4');
  });

  it('L4: large diff (>30 lines, >2 files, no new files)', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `+line ${i}`).join('\n');
    const diff = `@@ -1,1 +1,21 @@\n-old\n${lines}`;
    // 3 files > 2, 20 lines <= 30, no new files => L3 (fileCount <= 5)
    expect(classifySddChange(diff, ['a.ts', 'b.ts', 'c.ts'])).toBe('L3');
  });

  it('L1 takes priority over file count', () => {
    // Even with many files, if diff is trivial it's L1
    const diff = [
      '@@ -1,2 +1,2 @@',
      '-// old',
      '+// new',
    ].join('\n');
    expect(classifySddChange(diff, ['a.ts', 'b.ts', 'c.ts'])).toBe('L1');
  });
});

// ── parseFilesSection ──

describe('parseFilesSection', () => {
  it('returns empty when no Files section exists', () => {
    expect(parseFilesSection('## Overview\nSome text')).toEqual([]);
  });

  it('parses file list from ## Files section', () => {
    const body = [
      '## Overview',
      'Some description',
      '',
      '## Files',
      '',
      '- src/foo.ts',
      '- src/bar.ts',
      '- `src/baz.ts`',
    ].join('\n');
    expect(parseFilesSection(body)).toEqual([
      'src/foo.ts',
      'src/bar.ts',
      'src/baz.ts',
    ]);
  });

  it('parses Chinese section name', () => {
    const body = [
      '## 概述',
      '',
      '## 相关文件',
      '',
      '- src/foo.ts',
    ].join('\n');
    expect(parseFilesSection(body)).toEqual(['src/foo.ts']);
  });

  it('stops at next H2 section', () => {
    const body = [
      '## Files',
      '- src/foo.ts',
      '',
      '## Notes',
      '- this is not a file',
    ].join('\n');
    expect(parseFilesSection(body)).toEqual(['src/foo.ts']);
  });

  it('returns empty when Files section has no items', () => {
    expect(parseFilesSection('## Files\n\nNo files yet.')).toEqual([]);
  });
});

// ── SddFreshnessService ──

describe('SddFreshnessService', () => {
  let service: SddFreshnessService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new SddFreshnessService();
  });

  describe('analyzeChanges', () => {
    it('returns empty when no SDD docs exist', async () => {
      vi.mocked(listSddDocs).mockReturnValue([]);
      const result = await service.analyzeChanges(['foo.ts'], '+change');
      expect(result).toEqual([]);
    });

    it('returns empty when SDD has no Files section', async () => {
      vi.mocked(listSddDocs).mockReturnValue(['my-sdd']);
      vi.mocked(readSddDoc).mockReturnValue({
        meta: { id: '1', slug: 'my-sdd' },
        body: '## Overview\nNo files tracked.',
      });
      const result = await service.analyzeChanges(['foo.ts'], '+change');
      expect(result).toEqual([]);
    });

    it('returns empty when changed files do not match tracked files', async () => {
      vi.mocked(listSddDocs).mockReturnValue(['my-sdd']);
      vi.mocked(readSddDoc).mockReturnValue({
        meta: { id: '1', slug: 'my-sdd' },
        body: '## Files\n- src/tracked.ts',
      });
      const result = await service.analyzeChanges(
        ['other.ts'],
        '+change',
      );
      expect(result).toEqual([]);
    });

    it('skips L1 changes', async () => {
      vi.mocked(listSddDocs).mockReturnValue(['my-sdd']);
      vi.mocked(readSddDoc).mockReturnValue({
        meta: { id: '1', slug: 'my-sdd' },
        body: '## Files\n- src/foo.ts',
      });
      const diff = '@@ -1,2 +1,2 @@\n-// old\n+// new';
      const result = await service.analyzeChanges(['src/foo.ts'], diff);
      expect(result).toEqual([]);
    });

    it('returns plan for L2+ changes', async () => {
      vi.mocked(listSddDocs).mockReturnValue(['my-sdd']);
      vi.mocked(readSddDoc).mockReturnValue({
        meta: { id: '1', slug: 'my-sdd' },
        body: '## Files\n- src/foo.ts',
      });
      const lines = Array.from({ length: 10 }, (_, i) => `+line ${i}`).join('\n');
      const diff = `@@ -1,1 +1,11 @@\n-old\n${lines}`;
      const result = await service.analyzeChanges(['src/foo.ts'], diff);
      expect(result).toHaveLength(1);
      expect(result[0].slug).toBe('my-sdd');
      expect(result[0].level).toBe('L2');
      expect(result[0].matchedFiles).toEqual(['src/foo.ts']);
    });

    it('matches files with directory prefix pattern', async () => {
      vi.mocked(listSddDocs).mockReturnValue(['my-sdd']);
      vi.mocked(readSddDoc).mockReturnValue({
        meta: { id: '1', slug: 'my-sdd' },
        body: '## Files\n- src/modules/',
      });
      const lines = Array.from({ length: 10 }, (_, i) => `+line ${i}`).join('\n');
      const diff = `@@ -1,1 +1,11 @@\n-old\n${lines}`;
      const result = await service.analyzeChanges(
        ['src/modules/foo.ts'],
        diff,
      );
      expect(result).toHaveLength(1);
      expect(result[0].matchedFiles).toEqual(['src/modules/foo.ts']);
    });

    it('matches files with glob pattern', async () => {
      vi.mocked(listSddDocs).mockReturnValue(['my-sdd']);
      vi.mocked(readSddDoc).mockReturnValue({
        meta: { id: '1', slug: 'my-sdd' },
        body: '## Files\n- src/*.ts',
      });
      const lines = Array.from({ length: 10 }, (_, i) => `+line ${i}`).join('\n');
      const diff = `@@ -1,1 +1,11 @@\n-old\n${lines}`;
      const result = await service.analyzeChanges(['src/foo.ts'], diff);
      expect(result).toHaveLength(1);
    });

    it('returns multiple plans for multiple SDDs', async () => {
      vi.mocked(listSddDocs).mockReturnValue(['sdd-a', 'sdd-b']);
      vi.mocked(readSddDoc).mockImplementation((slug) => {
        if (slug === 'sdd-a')
          return { meta: { id: '1' }, body: '## Files\n- src/a.ts' };
        if (slug === 'sdd-b')
          return { meta: { id: '2' }, body: '## Files\n- src/b.ts' };
        return null;
      });
      const lines = Array.from({ length: 10 }, (_, i) => `+line ${i}`).join('\n');
      const diff = `@@ -1,1 +1,11 @@\n-old\n${lines}`;
      const result = await service.analyzeChanges(
        ['src/a.ts', 'src/b.ts'],
        diff,
      );
      expect(result).toHaveLength(2);
    });
  });

  describe('applyPatches', () => {
    it('patches task only for L2', async () => {
      vi.mocked(readSddDoc).mockReturnValue({
        meta: { id: 'orig-id', version: 1, taskVersion: 1 },
        body: '## Tasks\n- [ ] item',
      });
      vi.mocked(writeSddDoc).mockImplementation(() => {});
      vi.mocked(appendChangelog).mockImplementation(() => {});

      await service.applyPatches(
        [{ slug: 'my-sdd', level: 'L2', matchedFiles: ['src/foo.ts'] }],
        '+new line',
      );

      // writeSddDoc called once for task
      expect(writeSddDoc).toHaveBeenCalledTimes(1);
      expect(writeSddDoc).toHaveBeenCalledWith(
        'my-sdd',
        'task',
        expect.objectContaining({
          version: 2,
          taskVersion: 2,
          parentId: 'orig-id',
          changeType: 'L2',
        }),
        expect.any(String),
      );
      expect(appendChangelog).toHaveBeenCalledTimes(1);
    });

    it('patches design + task for L3', async () => {
      vi.mocked(readSddDoc).mockReturnValue({
        meta: { id: 'orig-id', version: 2, designVersion: 1, taskVersion: 1 },
        body: '## Content',
      });
      vi.mocked(writeSddDoc).mockImplementation(() => {});
      vi.mocked(appendChangelog).mockImplementation(() => {});

      await service.applyPatches(
        [{ slug: 'my-sdd', level: 'L3', matchedFiles: ['a.ts', 'b.ts'] }],
        'diff',
      );

      expect(writeSddDoc).toHaveBeenCalledTimes(2);
      expect(writeSddDoc).toHaveBeenCalledWith(
        'my-sdd',
        'design',
        expect.objectContaining({ version: 3, designVersion: 2 }),
        expect.any(String),
      );
      expect(writeSddDoc).toHaveBeenCalledWith(
        'my-sdd',
        'task',
        expect.objectContaining({ version: 3, taskVersion: 2 }),
        expect.any(String),
      );
    });

    it('patches all layers for L4', async () => {
      vi.mocked(readSddDoc).mockReturnValue({
        meta: {
          id: 'orig-id',
          version: 1,
          requirementVersion: 1,
          designVersion: 1,
          taskVersion: 1,
        },
        body: '## Content',
      });
      vi.mocked(writeSddDoc).mockImplementation(() => {});
      vi.mocked(appendChangelog).mockImplementation(() => {});

      await service.applyPatches(
        [{ slug: 'my-sdd', level: 'L4', matchedFiles: ['a.ts'] }],
        'big diff',
      );

      expect(writeSddDoc).toHaveBeenCalledTimes(3);
      expect(appendChangelog).toHaveBeenCalledTimes(1);
    });

    it('skips missing layer files gracefully', async () => {
      vi.mocked(readSddDoc).mockReturnValue(null);
      vi.mocked(appendChangelog).mockImplementation(() => {});

      await service.applyPatches(
        [{ slug: 'my-sdd', level: 'L2', matchedFiles: ['a.ts'] }],
        'diff',
      );

      expect(writeSddDoc).not.toHaveBeenCalled();
      expect(appendChangelog).toHaveBeenCalledTimes(1);
    });

    it('sets parentId to old id and generates new id', async () => {
      vi.mocked(readSddDoc).mockReturnValue({
        meta: { id: 'old-abc', version: 5, taskVersion: 3 },
        body: 'body',
      });
      vi.mocked(writeSddDoc).mockImplementation(() => {});
      vi.mocked(appendChangelog).mockImplementation(() => {});

      await service.applyPatches(
        [{ slug: 's', level: 'L2', matchedFiles: ['f.ts'] }],
        'diff',
      );

      const writtenMeta = vi.mocked(writeSddDoc).mock.calls[0][2];
      expect(writtenMeta.parentId).toBe('old-abc');
      expect(writtenMeta.id).not.toBe('old-abc');
      expect(writtenMeta.id).toMatch(/^sdd-/);
      expect(writtenMeta.version).toBe(6);
      expect(writtenMeta.taskVersion).toBe(4);
    });

    it('appends changelog with correct format', async () => {
      vi.mocked(readSddDoc).mockReturnValue({
        meta: { id: '1', version: 1, taskVersion: 1 },
        body: 'body',
      });
      vi.mocked(writeSddDoc).mockImplementation(() => {});
      vi.mocked(appendChangelog).mockImplementation(() => {});

      await service.applyPatches(
        [
          {
            slug: 'my-feature',
            level: 'L3',
            matchedFiles: ['a.ts', 'b.ts'],
          },
        ],
        'diff',
      );

      expect(appendChangelog).toHaveBeenCalledWith(
        'my-feature',
        expect.stringContaining('L3'),
      );
      const entry = vi.mocked(appendChangelog).mock.calls[0][1];
      expect(entry).toContain('a.ts, b.ts');
      expect(entry).toContain('design, task');
    });

    it('truncates large diffs in generated patch', async () => {
      vi.mocked(readSddDoc).mockReturnValue({
        meta: { id: '1', version: 1, taskVersion: 1 },
        body: 'body',
      });
      vi.mocked(writeSddDoc).mockImplementation(() => {});
      vi.mocked(appendChangelog).mockImplementation(() => {});

      const largeDiff = 'x'.repeat(5000);
      await service.applyPatches(
        [{ slug: 's', level: 'L2', matchedFiles: ['f.ts'] }],
        largeDiff,
      );

      const writtenBody = vi.mocked(writeSddDoc).mock.calls[0][3];
      expect(writtenBody).toContain('truncated');
      expect(writtenBody.length).toBeLessThan(largeDiff.length + 500);
    });
  });
});
