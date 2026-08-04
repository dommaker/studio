import { describe, it, expect } from 'vitest';
import { extractAffectedFiles } from '../error-file-extractor';

describe('extractAffectedFiles', () => {
  describe('layer 1: tsc pattern', () => {
    it('extracts file paths from tsc error format', () => {
      const error = 'src/foo.ts(10,5): error TS2322: Type \'string\' is not assignable to type \'number\'.';
      const result = extractAffectedFiles(error);
      expect(result).toContain('src/foo.ts');
    });

    it('extracts multiple tsc errors', () => {
      const error = [
        'src/foo.ts(10,5): error TS2322: Type mismatch',
        'src/bar.ts(20,3): error TS2345: Argument not assignable',
      ].join('\n');
      const result = extractAffectedFiles(error);
      expect(result).toContain('src/foo.ts');
      expect(result).toContain('src/bar.ts');
      expect(result.length).toBe(2);
    });
  });

  describe('layer 2: test failure pattern', () => {
    it('extracts file paths from FAIL format', () => {
      const error = 'FAIL src/__tests__/foo.test.ts\n  ● should work';
      const result = extractAffectedFiles(error);
      expect(result).toContain('src/__tests__/foo.test.ts');
    });

    it('extracts file paths from Error: format', () => {
      const error = 'Error: src/__tests__/bar.test.ts failed';
      const result = extractAffectedFiles(error);
      expect(result).toContain('src/__tests__/bar.test.ts');
    });
  });

  describe('layer 3: generic fallback', () => {
    it('extracts .ts paths from unstructured error when no layer 1+2 match', () => {
      const error = 'Cannot resolve module src/utils/helper.ts in context';
      const result = extractAffectedFiles(error);
      expect(result).toContain('src/utils/helper.ts');
    });

    it('extracts .tsx paths from unstructured error', () => {
      const error = 'Cannot resolve module src/components/App.tsx in context';
      const result = extractAffectedFiles(error);
      expect(result).toContain('src/components/App.tsx');
    });

    it('excludes node_modules paths', () => {
      const error = 'Error in node_modules/lodash/index.ts somewhere';
      const result = extractAffectedFiles(error);
      expect(result).not.toContain('node_modules/lodash/index.ts');
      expect(result.length).toBe(0);
    });

    it('excludes dist/ paths', () => {
      const error = 'Error in dist/bundle.ts somewhere';
      const result = extractAffectedFiles(error);
      expect(result).not.toContain('dist/bundle.ts');
      expect(result.length).toBe(0);
    });
  });

  describe('fallback gating', () => {
    it('does not enable generic fallback when layer 1+2 have matches', () => {
      const error = [
        'src/foo.ts(10,5): error TS2322: Type mismatch',
        'Also mentions src/other.ts in passing',
      ].join('\n');
      const result = extractAffectedFiles(error);
      expect(result).toContain('src/foo.ts');
      // generic fallback not enabled, so src/other.ts should not appear
      expect(result).not.toContain('src/other.ts');
    });
  });

  describe('deduplication', () => {
    it('deduplicates files matched by multiple patterns', () => {
      const error = [
        'src/foo.ts(10,5): error TS2322: Type mismatch',
        'src/foo.ts(20,3): error TS2345: Another error',
      ].join('\n');
      const result = extractAffectedFiles(error);
      expect(result).toEqual(['src/foo.ts']);
    });
  });

  describe('no match', () => {
    it('returns empty array when no .ts references found', () => {
      const error = 'Error: something went wrong but no file paths here';
      const result = extractAffectedFiles(error);
      expect(result).toEqual([]);
    });

    it('returns empty array for empty input', () => {
      const result = extractAffectedFiles('');
      expect(result).toEqual([]);
    });
  });
});
