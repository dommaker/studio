/**
 * Tests for analyst-fact-verification.ts (D6)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { verifyAnalystFacts, type FactCheckResult } from '../analyst-fact-verification.js';
import * as fs from 'fs';
import * as path from 'path';

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);

describe('verifyAnalystFacts', () => {
  const repoDir = '/repo';

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue('');
  });

  describe('import verification', () => {
    it('passes when import path resolves to existing file', () => {
      mockExistsSync.mockImplementation((p: fs.PathLike) => {
        const s = String(p);
        return s === '/repo/apps/api/src/modules/foo.ts' ||
               s === '/repo/apps/api/src/modules/bar.ts';
      });

      const results = verifyAnalystFacts([{
        id: 'group-1',
        files: ['apps/api/src/modules/foo.ts'],
        architectureContext: {
          imports: [`import { baz } from './bar.js'`],
          functions: [],
        },
      }], repoDir);

      const failures = results.filter(r => !r.passed);
      expect(failures).toHaveLength(0);
    });

    it('fails when import path does not resolve', () => {
      mockExistsSync.mockImplementation((p: fs.PathLike) => {
        return String(p) === '/repo/apps/api/src/modules/foo.ts'; // source exists, import target doesn't
      });

      const results = verifyAnalystFacts([{
        id: 'group-1',
        files: ['apps/api/src/modules/foo.ts'],
        architectureContext: {
          imports: [`import { baz } from './nonexistent.js'`],
          functions: [],
        },
      }], repoDir);

      const failures = results.filter(r => !r.passed && r.name === 'import-not-found');
      expect(failures).toHaveLength(1);
      expect(failures[0].message).toContain('nonexistent');
    });

    it('skips package imports (node_modules)', () => {
      const results = verifyAnalystFacts([{
        id: 'group-1',
        files: ['src/foo.ts'],
        architectureContext: {
          imports: [`import { prisma } from '@dommaker/studio-prisma'`],
          functions: [],
        },
      }], repoDir);

      // No import failures — package imports are skipped
      const importFailures = results.filter(r => !r.passed && r.name.includes('import'));
      expect(importFailures).toHaveLength(0);
    });

    it('tries multiple extensions (.ts, .js, index.ts)', () => {
      mockExistsSync.mockImplementation((p: fs.PathLike) => {
        const s = String(p);
        // Only .ts extension exists
        return s === '/repo/apps/api/src/foo.ts' ||
               s === '/repo/apps/api/src/bar.ts';
      });

      const results = verifyAnalystFacts([{
        id: 'group-1',
        files: ['apps/api/src/foo.ts'],
        architectureContext: {
          imports: [`import { x } from './bar'`], // no extension
          functions: [],
        },
      }], repoDir);

      const failures = results.filter(r => !r.passed && r.name === 'import-not-found');
      expect(failures).toHaveLength(0);
    });

    it('handles monorepo path resolution', () => {
      mockExistsSync.mockImplementation((p: fs.PathLike) => {
        const s = String(p);
        return s === '/repo/packages/studio-shared/src/index.ts' ||
               s === '/repo/apps/api/src/service.ts';
      });

      const results = verifyAnalystFacts([{
        id: 'group-1',
        files: ['apps/api/src/service.ts'],
        architectureContext: {
          imports: [`import { helper } from '../../../packages/studio-shared/src/index.js'`],
          functions: [],
        },
      }], repoDir);

      const failures = results.filter(r => !r.passed && r.name === 'import-not-found');
      expect(failures).toHaveLength(0);
    });
  });

  describe('function verification', () => {
    it('passes when function name exists in file', () => {
      mockExistsSync.mockImplementation((p: fs.PathLike) => {
        return String(p) === '/repo/apps/api/src/service.ts';
      });
      mockReadFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
        if (String(p) === '/repo/apps/api/src/service.ts') {
          return 'export function handleRequest(req: Request): Response { ... }';
        }
        return '';
      });

      const results = verifyAnalystFacts([{
        id: 'group-1',
        files: ['apps/api/src/service.ts'],
        architectureContext: {
          imports: [],
          functions: ['handleRequest(req: Request): Response'],
        },
      }], repoDir);

      const failures = results.filter(r => !r.passed && r.name === 'function-not-found');
      expect(failures).toHaveLength(0);
    });

    it('fails when function name not found in any group file', () => {
      mockExistsSync.mockImplementation((p: fs.PathLike) => {
        return String(p) === '/repo/apps/api/src/service.ts';
      });
      mockReadFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
        if (String(p) === '/repo/apps/api/src/service.ts') {
          return 'export function otherFunction() { }';
        }
        return '';
      });

      const results = verifyAnalystFacts([{
        id: 'group-1',
        files: ['apps/api/src/service.ts'],
        architectureContext: {
          imports: [],
          functions: ['handleRequest(req: Request): Response'],
        },
      }], repoDir);

      const failures = results.filter(r => !r.passed && r.name === 'function-not-found');
      expect(failures).toHaveLength(1);
      expect(failures[0].message).toContain('handleRequest');
    });

    it('extracts function name from various signature formats', () => {
      mockExistsSync.mockImplementation((p: fs.PathLike) => {
        return String(p) === '/repo/src/mod.ts';
      });
      mockReadFileSync.mockReturnValue(`
        export async function fetchData() {}
        const processItem = (x: any) => x;
        class Foo { bar() {} }
        get value() { return 1; }
      `);

      const groups = [{
        id: 'g1',
        files: ['src/mod.ts'],
        architectureContext: {
          imports: [],
          functions: [
            'async function fetchData()',
            'const processItem = (x: any) => void',
            'bar()',
            'get value()',
          ],
        },
      }];

      const results = verifyAnalystFacts(groups, repoDir);
      const failures = results.filter(r => !r.passed && r.name === 'function-not-found');
      expect(failures).toHaveLength(0);
    });
  });

  describe('edge cases', () => {
    it('skips groups without architectureContext', () => {
      const results = verifyAnalystFacts([{
        id: 'group-1',
        files: ['src/foo.ts'],
        // no architectureContext
      }], repoDir);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].name).toBe('fact-check-summary');
    });

    it('skips groups without files', () => {
      const results = verifyAnalystFacts([{
        id: 'group-1',
        // no files
        architectureContext: {
          imports: [`import { x } from './bar.js'`],
          functions: ['someFunc()'],
        },
      }], repoDir);

      // Should not crash, no failures because can't resolve without source file
      const failures = results.filter(r => !r.passed);
      expect(failures).toHaveLength(0);
    });

    it('handles empty architectureContext fields', () => {
      const results = verifyAnalystFacts([{
        id: 'group-1',
        files: ['src/foo.ts'],
        architectureContext: {
          imports: [],
          functions: [],
        },
      }], repoDir);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('handles multiple groups', () => {
      mockExistsSync.mockImplementation((p: fs.PathLike) => {
        const s = String(p);
        return s === '/repo/src/a.ts' || s === '/repo/src/b.ts';
      });
      mockReadFileSync.mockReturnValue('export function foo() {}');

      const results = verifyAnalystFacts([
        {
          id: 'g1',
          files: ['src/a.ts'],
          architectureContext: { imports: [], functions: ['foo()'] },
        },
        {
          id: 'g2',
          files: ['src/b.ts'],
          architectureContext: { imports: [], functions: ['foo()'] },
        },
      ], repoDir);

      const failures = results.filter(r => !r.passed);
      expect(failures).toHaveLength(0);
    });
  });
});
