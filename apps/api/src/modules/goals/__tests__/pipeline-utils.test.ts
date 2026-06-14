/**
 * Pipeline Utils 契约测试
 *
 * 覆盖: parseAcGroups, resolveDependencies, routeModel, buildSkillPrompt, grepACTests, harnessCheck
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('fs', async () => ({
  ...await vi.importActual('fs'),
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  readdirSync: vi.fn().mockReturnValue([]),
}));

vi.mock('child_process', () => ({
  execSync: vi.fn().mockReturnValue(''),
}));

// Dynamic import after mocks
const { parseAcGroups, resolveDependencies, routeModel, buildSkillPrompt, grepACTests, harnessCheck, SKILLS_DIR } = await import('../pipeline-utils.js');
const mockFs = vi.mocked(fs);
const { execSync } = await import('child_process');
const mockExecSync = vi.mocked(execSync);

// ─── Helpers ───

function makeGroup(overrides: Partial<{
  id: string; acs: string[]; files: string[]; dependencies: string[];
  implementationNotes: string; codePatterns: string[]; gotchas: string[];
  modelTier: string; modelTierReason: string;
}> = {}) {
  return {
    id: 'g1',
    acs: ['AC1: do something'],
    files: ['src/a.ts'],
    dependencies: [],
    implementationNotes: 'notes',
    codePatterns: [],
    gotchas: [],
    ...overrides,
  };
}

// ─── parseAcGroups ───

describe('parseAcGroups', () => {
  /** Wrap requirement-layer group into three-layer spec */
  function makeSpec(reqGroups: any[], designGroups?: any[], taskGroups?: any[]) {
    return {
      requirement: { acGroups: reqGroups },
      design: { acGroups: designGroups || [] },
      task: { acGroups: taskGroups || [] },
    };
  }

  it('extracts valid AcGroup array from RequirementsDocJson', () => {
    const spec = makeSpec([makeGroup()]);
    const result = parseAcGroups(spec as any);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('g1');
    expect(result[0].acs).toEqual(['AC1: do something']);
  });

  it('filters out entries missing id', () => {
    const spec = makeSpec([makeGroup(), { acs: ['AC2'], files: [], dependencies: [] }]);
    const result = parseAcGroups(spec as any);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('g1');
  });

  it('filters out entries with empty acs', () => {
    const spec = makeSpec([makeGroup({ id: 'valid', acs: ['AC1'] }), makeGroup({ id: 'empty', acs: [] })]);
    const result = parseAcGroups(spec as any);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('valid');
  });

  it('returns empty array for empty acGroups', () => {
    expect(parseAcGroups(makeSpec([]) as any)).toEqual([]);
  });

  it('returns empty array for missing requirement', () => {
    expect(parseAcGroups({ requirement: {}, design: { acGroups: [] }, task: { acGroups: [] } } as any)).toEqual([]);
  });

  it('returns empty array for missing requirement key', () => {
    expect(parseAcGroups({} as any)).toEqual([]);
  });

  it('preserves optional design fields via id merge', () => {
    const reqGroup = makeGroup({ id: 'g1' });
    const designGroup = { id: 'g1', implementationNotes: 'notes', modelTier: 'premium', modelTierReason: 'complex', codePatterns: ['pattern1'], gotchas: ['gotcha1'] };
    const result = parseAcGroups(makeSpec([reqGroup], [designGroup]) as any);
    expect(result[0].modelTier).toBe('premium');
    expect(result[0].codePatterns).toEqual(['pattern1']);
    expect(result[0].gotchas).toEqual(['gotcha1']);
    expect(result[0].implementationNotes).toBe('notes');
  });

  it('merges task fields via id', () => {
    const reqGroup = makeGroup({ id: 'g1' });
    const taskGroup = { id: 'g1', contractTests: [{ file: 't.ts', content: 'code' }], testFiles: ['t.test.ts'] };
    const result = parseAcGroups(makeSpec([reqGroup], [], [taskGroup]) as any);
    expect(result[0].contractTests).toEqual([{ file: 't.ts', content: 'code' }]);
    expect(result[0].testFiles).toEqual(['t.test.ts']);
  });
});

// ─── resolveDependencies ───

describe('resolveDependencies', () => {
  it('returns groups organized by dependency layers', () => {
    const groups = [
      makeGroup({ id: 'a', acs: ['AC1'], dependencies: [] }),
      makeGroup({ id: 'b', acs: ['AC2'], dependencies: ['a'] }),
    ];
    const layers = resolveDependencies(groups);
    expect(layers).toHaveLength(2);
    expect(layers[0][0].id).toBe('a');
    expect(layers[1][0].id).toBe('b');
  });

  it('groups without dependencies go to layer 0', () => {
    const groups = [
      makeGroup({ id: 'a', acs: ['AC1'], dependencies: [] }),
      makeGroup({ id: 'b', acs: ['AC2'], dependencies: [] }),
    ];
    const layers = resolveDependencies(groups);
    expect(layers).toHaveLength(1);
    expect(layers[0]).toHaveLength(2);
  });

  it('handles multi-level dependencies', () => {
    const groups = [
      makeGroup({ id: 'a', acs: ['AC1'], dependencies: [] }),
      makeGroup({ id: 'b', acs: ['AC2'], dependencies: ['a'] }),
      makeGroup({ id: 'c', acs: ['AC3'], dependencies: ['a'] }),
      makeGroup({ id: 'd', acs: ['AC4'], dependencies: ['b', 'c'] }),
    ];
    const layers = resolveDependencies(groups);
    expect(layers).toHaveLength(3);
    expect(layers[0].map(g => g.id)).toEqual(['a']);
    expect(layers[1].map(g => g.id).sort()).toEqual(['b', 'c']);
    expect(layers[2].map(g => g.id)).toEqual(['d']);
  });

  it('throws on circular dependency', () => {
    const groups = [
      makeGroup({ id: 'a', acs: ['AC1'], dependencies: ['b'] }),
      makeGroup({ id: 'b', acs: ['AC2'], dependencies: ['a'] }),
    ];
    expect(() => resolveDependencies(groups)).toThrow(/circular/i);
  });

  it('ignores dependencies on non-existent groups', () => {
    const groups = [
      makeGroup({ id: 'a', acs: ['AC1'], dependencies: ['nonexistent'] }),
    ];
    const layers = resolveDependencies(groups);
    expect(layers).toHaveLength(1);
    expect(layers[0][0].id).toBe('a');
  });

  it('returns empty array for empty input', () => {
    expect(resolveDependencies([])).toEqual([]);
  });
});

// ─── routeModel ───

describe('routeModel', () => {
  it('uses analyst modelTier when present', () => {
    const group = makeGroup({ modelTier: 'premium', modelTierReason: 'complex domain' });
    const result = routeModel(group);
    expect(result.tier).toBe('premium');
    expect(result.reason).toBe('complex domain');
  });

  it('falls back to default reason when modelTier has no reason', () => {
    const group = makeGroup({ modelTier: 'fast' });
    const result = routeModel(group);
    expect(result.tier).toBe('fast');
    expect(result.reason).toBe('analyst-classified');
  });

  it('classifies high-risk keywords as premium', () => {
    const group = makeGroup({ implementationNotes: 'implement authentication flow' });
    const result = routeModel(group);
    expect(result.tier).toBe('premium');
    expect(result.reason).toContain('highRiskKeyword');
  });

  it('classifies high acCount as premium', () => {
    const group = makeGroup({ acs: ['AC1', 'AC2', 'AC3', 'AC4', 'AC5', 'AC6'] });
    const result = routeModel(group);
    expect(result.tier).toBe('premium');
    expect(result.reason).toContain('acCount=6');
  });

  it('classifies low-risk + few acs as fast', () => {
    const group = makeGroup({
      acs: ['AC1'],
      files: ['src/a.ts'],
      implementationNotes: 'fix typo in readme',
    });
    const result = routeModel(group);
    expect(result.tier).toBe('fast');
    expect(result.reason).toContain('lowRisk');
  });

  it('defaults to standard', () => {
    const group = makeGroup({
      acs: ['AC1', 'AC2', 'AC3'],
      files: ['src/a.ts', 'src/b.ts'],
      implementationNotes: 'refactor the module structure',
    });
    const result = routeModel(group);
    expect(result.tier).toBe('standard');
  });
});

// ─── buildSkillPrompt ───

describe('buildSkillPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads template from trigger subdirectory and replaces placeholders', () => {
    mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = p.toString();
      if (s === SKILLS_DIR) return true;
      if (s.includes('sub-agent') && s.includes('sub-agent-workflow')) return true;
      return false;
    });
    mockFs.readdirSync.mockReturnValue([
      { name: 'sub-agent', isDirectory: () => true, isFile: () => false },
    ] as any);
    mockFs.readFileSync.mockReturnValue('---\nname: sub-agent-workflow\nversion: 1\n---\n## Task\n{{task}}\n\n## Constraints\n{{constraints}}');

    const result = buildSkillPrompt('sub-agent-workflow', { task: 'implement feature', constraints: 'no any' });
    expect(result).toContain('implement feature');
    expect(result).toContain('no any');
    expect(result).not.toContain('{{task}}');
  });

  it('returns empty string for nonexistent skill', () => {
    mockFs.existsSync.mockReturnValue(false);
    expect(buildSkillPrompt('nonexistent', {})).toBe('');
  });

  it('returns empty string when SKILLS_DIR does not exist', () => {
    mockFs.existsSync.mockReturnValue(false);
    expect(buildSkillPrompt('any-skill', {})).toBe('');
  });

  it('replaces all placeholder variants', () => {
    mockFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = p.toString();
      if (s === SKILLS_DIR) return true;
      return s.includes('always') && s.includes('test-skill');
    });
    mockFs.readdirSync.mockReturnValue([
      { name: 'always', isDirectory: () => true, isFile: () => false },
    ] as any);
    mockFs.readFileSync.mockReturnValue('---\nname: test\n---\n{{task}}|{{constraints}}|{{knowledgeContext}}|{{capabilities}}');

    const result = buildSkillPrompt('test-skill', {
      task: 'T', constraints: 'C', knowledgeContext: 'K', capabilities: 'Cap',
    });
    expect(result).toBe('T|C|K|Cap');
  });
});

// ─── grepACTests ───

describe('grepACTests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns matched=true when AC text found in test file', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockImplementation(((p: fs.PathLike, opts?: any) => {
      const s = p.toString();
      if (s.includes('test-dir')) {
        return [{ name: 'feature.test.ts', isDirectory: () => false, isFile: () => true }] as any;
      }
      return [] as any;
    }) as any);
    mockFs.readFileSync.mockImplementation(((p: fs.PathLike) => {
      if (p.toString().includes('feature.test.ts')) {
        return "describe('AC1: do something', () => { it('works', () => {}) })";
      }
      return '';
    }) as any);

    // Mock statSync for findTestFiles
    mockFs.statSync = vi.fn().mockReturnValue({ isDirectory: () => false, isFile: () => true }) as any;

    const results = grepACTests(['AC1: do something'], 'test-dir');
    expect(results).toHaveLength(1);
    expect(results[0].matched).toBe(true);
    expect(results[0].testFile).toBe('feature.test.ts');
  });

  it('returns matched=false when AC text not found', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockReturnValue([
      { name: 'other.test.ts', isDirectory: () => false, isFile: () => true },
    ] as any);
    mockFs.readFileSync.mockReturnValue("describe('other test', () => {})");
    mockFs.statSync = vi.fn().mockReturnValue({ isDirectory: () => false, isFile: () => true }) as any;

    const results = grepACTests(['AC1: missing feature'], 'test-dir');
    expect(results[0].matched).toBe(false);
    expect(results[0].testFile).toBe('');
  });

  it('returns empty array for empty acs', () => {
    expect(grepACTests([], 'test-dir')).toEqual([]);
  });

  it('handles non-existent dir gracefully', () => {
    mockFs.existsSync.mockReturnValue(false);
    expect(grepACTests(['AC1'], '/nonexistent')).toEqual([
      { acId: 'AC1', testFile: '', matched: false },
    ]);
  });
});

// ─── harnessCheck ───

describe('harnessCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFs.existsSync.mockReturnValue(true);
  });

  it('returns passed=true when tsc and test succeed', async () => {
    mockExecSync.mockReturnValue('');
    const result = await harnessCheck('/workdir');
    expect(result.passed).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('returns passed=false with tsc errors when tsc fails', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('tsc')) {
        const err = new Error('tsc failed') as Error & { stderr: string };
        err.stderr = 'TS1234: type error';
        throw err;
      }
      return '';
    });
    const result = await harnessCheck('/workdir');
    expect(result.passed).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('tsc failed');
  });

  it('returns passed=false with test errors when npm test fails', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('npm test')) {
        const err = new Error('test failed') as Error & { stdout: string };
        err.stdout = 'FAIL src/test.ts';
        throw err;
      }
      return '';
    });
    const result = await harnessCheck('/workdir');
    expect(result.passed).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('npm test failed');
  });

  it('collects both tsc and test errors', async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('command failed');
    });
    const result = await harnessCheck('/workdir');
    expect(result.passed).toBe(false);
    expect(result.errors).toHaveLength(2);
  });

  it('returns error when workdir does not exist', async () => {
    mockFs.existsSync.mockReturnValue(false);
    const result = await harnessCheck('/nonexistent');
    expect(result.passed).toBe(false);
    expect(result.errors[0]).toContain('workdir not found');
  });
});
