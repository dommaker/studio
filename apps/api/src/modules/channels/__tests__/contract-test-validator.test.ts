/**
 * Contract Test Validator tests — Layer 1-3 pure functions
 *
 * CT-1 monitoring: validation results per layer
 * CT-2 monitoring: AC coverage summary
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  checkAcCoverage,
  countTestBlocks,
  extractKeywords,
  validateTypeScriptSyntax,
  validateImportPaths,
  validateContractTests,
  type AcGroupInfo,
} from '../contract-test-validator.js';

// ========================================
// Helpers
// ========================================

function makeAcGroup(overrides: Partial<AcGroupInfo> & { id: string }): AcGroupInfo {
  return {
    acs: [],
    files: [],
    ...overrides,
  };
}

// ========================================
// Layer 1: AC Coverage
// ========================================

describe('checkAcCoverage', () => {
  it('fails when no contractTests and no skipReason', () => {
    const acGroup = makeAcGroup({ id: 'g1', acs: ['AC1', 'AC2'] });
    const result = checkAcCoverage(acGroup, undefined, undefined);

    expect(result.pass).toBe(false);
    expect(result.hasContractTests).toBe(false);
    expect(result.totalAcs).toBe(2);
    expect(result.coveredAcs).toBe(0);
    expect(result.uncoveredAcs).toEqual(['AC1', 'AC2']);
  });

  it('passes when no contractTests but has skipReason', () => {
    const acGroup = makeAcGroup({ id: 'g1', acs: ['AC1'] });
    const result = checkAcCoverage(acGroup, undefined, '纯文件创建，无代码行为可测');

    expect(result.pass).toBe(true);
    expect(result.skipReason).toBe('纯文件创建，无代码行为可测');
    expect(result.hasContractTests).toBe(false);
  });

  it('passes when test blocks >= ACs with good content', () => {
    const acGroup = makeAcGroup({
      id: 'g1',
      acs: ['should create user', 'should delete user'],
    });
    const contractTests = [{
      file: 'g1.test.ts',
      content: `
        import { describe, it, expect } from 'vitest';
        describe('g1', () => {
          it('should create user', () => {});
          it('should delete user', () => {});
        });
      `,
    }];

    const result = checkAcCoverage(acGroup, contractTests, undefined);

    expect(result.pass).toBe(true);
    expect(result.hasContractTests).toBe(true);
    expect(result.coveredAcs).toBe(2);
    expect(result.coverageRate).toBeGreaterThanOrEqual(0.6);
  });

  it('fails when test blocks < 60% of ACs', () => {
    const acGroup = makeAcGroup({
      id: 'g1',
      acs: ['AC1', 'AC2', 'AC3', 'AC4', 'AC5'],
    });
    const contractTests = [{
      file: 'g1.test.ts',
      content: `
        it('AC1', () => {});
      `,
    }];

    const result = checkAcCoverage(acGroup, contractTests, undefined);

    // 1 test for 5 ACs = 20% < 60% → fail
    expect(result.pass).toBe(false);
  });

  it('passes when acGroup id is mentioned in test content', () => {
    const acGroup = makeAcGroup({
      id: 'lifecycle-persist',
      acs: ['AC1', 'AC2'],
    });
    const contractTests = [{
      file: 'test.ts',
      content: `
        // lifecycle-persist tests
        it('AC1', () => {});
      `,
    }];

    const result = checkAcCoverage(acGroup, contractTests, undefined);

    // Mentions acGroup id → 80% heuristic
    expect(result.pass).toBe(true);
    expect(result.coverageRate).toBeGreaterThanOrEqual(0.8);
  });

  it('handles empty acs array', () => {
    const acGroup = makeAcGroup({ id: 'g1', acs: [] });
    const result = checkAcCoverage(acGroup, [], undefined);

    expect(result.pass).toBe(false); // No tests, no skip
    expect(result.totalAcs).toBe(0);
  });
});

describe('countTestBlocks', () => {
  it('counts test and it blocks', () => {
    const content = `
      test('a', () => {});
      it('b', () => {});
      test.each([1, 2])('c', () => {});
    `;
    expect(countTestBlocks(content)).toBe(3);
  });

  it('excludes describe blocks from count', () => {
    const content = `
      describe('suite', () => {
        it('test1', () => {});
        it('test2', () => {});
      });
    `;
    expect(countTestBlocks(content)).toBe(2);
  });

  it('returns 0 for empty content', () => {
    expect(countTestBlocks('')).toBe(0);
    expect(countTestBlocks('// just a comment')).toBe(0);
  });
});

describe('extractKeywords', () => {
  it('extracts meaningful keywords from ACs', () => {
    const acs = ['should create user', 'should delete user'];
    const keywords = extractKeywords(acs);

    expect(keywords).toContain('create');
    expect(keywords).toContain('delete');
    expect(keywords).toContain('user');
    // Should not contain stop words
    expect(keywords).not.toContain('should');
  });

  it('filters out stop words', () => {
    const acs = ['the quick brown fox'];
    const keywords = extractKeywords(acs);

    expect(keywords).toContain('quick');
    expect(keywords).toContain('brown');
    expect(keywords).not.toContain('the');
  });

  it('filters out short words', () => {
    const acs = ['a b cd efg'];
    const keywords = extractKeywords(acs);

    expect(keywords).toContain('efg');
    expect(keywords).not.toContain('cd'); // too short
  });

  it('returns empty array for empty input', () => {
    expect(extractKeywords([])).toEqual([]);
  });
});

// ========================================
// Layer 2: TypeScript Syntax
// ========================================

describe('validateTypeScriptSyntax', () => {
  it('passes for valid test code', () => {
    const content = `
      import { describe, it, expect } from 'vitest';
      describe('suite', () => {
        it('test1', () => {
          expect(true).toBe(true);
        });
      });
    `;
    const result = validateTypeScriptSyntax('g1', 'test.ts', content);

    expect(result.pass).toBe(true);
    expect(result.syntaxErrors).toEqual([]);
  });

  it('detects test block missing callback', () => {
    const content = `
      test('missing callback');
    `;
    const result = validateTypeScriptSyntax('g1', 'test.ts', content);

    // Should detect missing 2nd argument
    expect(result.pass).toBe(false);
    expect(result.syntaxErrors.length).toBeGreaterThan(0);
  });

  it('passes for minimal test code', () => {
    const content = `it('works', () => {});`;
    const result = validateTypeScriptSyntax('g1', 'test.ts', content);

    expect(result.pass).toBe(true);
  });
});

// ========================================
// Layer 3: Import Path Validation
// ========================================

describe('validateImportPaths', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-validator-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('passes for external modules (node:, npm packages)', () => {
    const content = `
      import { describe } from 'vitest';
      import * as fs from 'node:fs';
    `;
    const result = validateImportPaths('g1', 'test.ts', content, tmpDir);

    expect(result.pass).toBe(true);
    expect(result.importPaths.length).toBe(2);
    expect(result.importPaths.every(p => p.resolved)).toBe(true);
  });

  it('resolves relative import to existing file', () => {
    // Create a file to import
    fs.writeFileSync(path.join(tmpDir, 'helper.ts'), 'export const x = 1;');

    const content = `import { x } from './helper';`;
    const result = validateImportPaths('g1', 'test.ts', content, tmpDir);

    expect(result.pass).toBe(true);
    expect(result.importPaths[0].resolved).toBe(true);
  });

  it('treats non-existing file in existing dir as forward reference', () => {
    const content = `import { x } from './nonexistent';`;
    const result = validateImportPaths('g1', 'test.ts', content, tmpDir);

    expect(result.pass).toBe(true);
    expect(result.importPaths[0].resolved).toBe(true);
    expect(result.importPaths[0].reason).toContain('forward reference');
  });

  it('resolves index file imports', () => {
    const moduleDir = path.join(tmpDir, 'mymodule');
    fs.mkdirSync(moduleDir);
    fs.writeFileSync(path.join(moduleDir, 'index.ts'), 'export const x = 1;');

    const content = `import { x } from './mymodule';`;
    const result = validateImportPaths('g1', 'test.ts', content, tmpDir);

    expect(result.pass).toBe(true);
    expect(result.importPaths[0].resolved).toBe(true);
  });

  it('handles no imports', () => {
    const content = `const x = 1;`;
    const result = validateImportPaths('g1', 'test.ts', content, tmpDir);

    expect(result.pass).toBe(true);
    expect(result.importPaths).toEqual([]);
  });
});

// ========================================
// Aggregated Validation
// ========================================

describe('validateContractTests', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-validator-agg-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns overallPass true when all layers pass', () => {
    const requirementAcGroups = [
      { id: 'g1', acs: ['AC1'], files: ['a.ts'] },
    ];
    const taskAcGroups = [
      {
        id: 'g1',
        contractTests: [{
          file: 'g1.test.ts',
          content: `import { it } from 'vitest'; it('AC1', () => {});`,
        }],
      },
    ];

    const report = validateContractTests(requirementAcGroups, taskAcGroups, tmpDir);

    expect(report.layer1.length).toBe(1);
    expect(report.layer2.length).toBe(1);
    expect(report.layer3.length).toBe(1);
    expect(report.overallPass).toBe(true);
  });

  it('returns overallPass false when layer 1 fails', () => {
    const requirementAcGroups = [
      { id: 'g1', acs: ['AC1', 'AC2'], files: ['a.ts'] },
    ];
    const taskAcGroups = [
      { id: 'g1', contractTests: undefined },
    ];

    const report = validateContractTests(requirementAcGroups, taskAcGroups, tmpDir);

    expect(report.layer1[0].pass).toBe(false);
    expect(report.overallPass).toBe(false);
  });

  it('skips layer 2/3 when acGroup has no contractTests', () => {
    const requirementAcGroups = [
      { id: 'g1', acs: ['AC1'], files: ['a.ts'] },
    ];
    const taskAcGroups = [
      { id: 'g1', contractTests: undefined, contractTestsSkipReason: 'pure config' },
    ];

    const report = validateContractTests(requirementAcGroups, taskAcGroups, tmpDir);

    expect(report.layer1.length).toBe(1);
    expect(report.layer2.length).toBe(0);
    expect(report.layer3.length).toBe(0);
    expect(report.overallPass).toBe(true);
  });

  it('handles multiple acGroups with mixed results', () => {
    const requirementAcGroups = [
      { id: 'g1', acs: ['AC1'], files: ['a.ts'] },
      { id: 'g2', acs: ['AC2'], files: ['b.ts'] },
    ];
    const taskAcGroups = [
      {
        id: 'g1',
        contractTests: [{
          file: 'g1.test.ts',
          content: `it('AC1', () => {});`,
        }],
      },
      {
        id: 'g2',
        contractTests: undefined, // Missing tests, no skip reason
      },
    ];

    const report = validateContractTests(requirementAcGroups, taskAcGroups, tmpDir);

    expect(report.layer1.length).toBe(2);
    expect(report.layer1[0].pass).toBe(true);
    expect(report.layer1[1].pass).toBe(false);
    expect(report.overallPass).toBe(false);
  });
});
