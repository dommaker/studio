// B5-H01: Analyst 输出 JSON Schema 验证测试
import { describe, it, expect } from 'vitest';

// 直接测试验证逻辑（不依赖外部模块）
interface AnalystOutput {
  title?: string;
  requirement?: {
    title?: string;
    acGroups?: Array<{
      id?: string;
      acs?: unknown[];
      files?: unknown[];
      dependencies?: unknown[];
    }>;
    tags?: unknown[];
    constraints?: unknown[];
    discoveries?: unknown[];
  };
  task?: {
    acGroups?: Array<{
      id?: string;
      contractTests?: unknown[];
    }>;
  };
  acGroups?: Array<{
    id?: string;
    acs?: unknown[];
    files?: unknown[];
    dependencies?: unknown[];
    implementationNotes?: string;
  }>;
  tags?: unknown[];
  constraints?: unknown[];
  discoveries?: unknown[];
}

function validateAnalystOutput(doc: unknown): string[] {
  const errors: string[] = [];
  if (!doc || typeof doc !== 'object') {
    return ['Output is not an object'];
  }
  const d = doc as AnalystOutput;

  // Support both flat (legacy) and nested (requirement.*) structure
  const acGroups = d.requirement?.acGroups ?? d.acGroups;
  const taskAcGroups = d.task?.acGroups;

  if (d.title !== undefined && typeof d.title !== 'string') {
    errors.push('title must be a string');
  }

  if (!Array.isArray(acGroups) || acGroups.length === 0) {
    errors.push('acGroups must be a non-empty array');
  } else {
    for (let i = 0; i < acGroups.length; i++) {
      const g = acGroups[i];
      if (!g || typeof g !== 'object') { errors.push(`acGroups[${i}] must be an object`); continue; }
      if (typeof g.id !== 'string' || !g.id.trim()) errors.push(`acGroups[${i}].id must be a non-empty string`);
      if (!Array.isArray(g.acs) || g.acs.length === 0) errors.push(`acGroups[${i}].acs must be a non-empty array`);
      if (g.files !== undefined && !Array.isArray(g.files)) errors.push(`acGroups[${i}].files must be an array`);
      if (g.dependencies !== undefined && !Array.isArray(g.dependencies)) errors.push(`acGroups[${i}].dependencies must be an array`);
    }

    // AC-3: contractTests 非空时，AC 不得含"写测试"类指令
    const hasContractTests = taskAcGroups?.some(g => Array.isArray(g.contractTests) && g.contractTests.length > 0);
    const testKeywords = ['写测试', '创建测试', '新增测试', 'write test', 'create test', 'add test'];
    if (hasContractTests) {
      for (let i = 0; i < acGroups.length; i++) {
        const g = acGroups[i];
        if (!g || !Array.isArray(g.acs)) continue;
        for (const ac of g.acs) {
          if (typeof ac !== 'string') continue;
          const lower = ac.toLowerCase();
          if (testKeywords.some(k => lower.includes(k))) {
            errors.push(`acGroups[${i}]: AC 不得包含"写测试"指令（contractTests 已提供契约测试）: "${ac.slice(0, 60)}"`);
          }
        }
      }
    }

    // AC-4: AC 不得是纯验证步骤（无 files 时）
    const verifyOnlyPattern = /^(跑|运行|执行|run|execute|验证)\s*(测试|test|tsc|vitest)/;
    for (let i = 0; i < acGroups.length; i++) {
      const g = acGroups[i];
      if (!g || !Array.isArray(g.acs)) continue;
      const hasFiles = Array.isArray(g.files) && g.files.length > 0;
      for (const ac of g.acs) {
        if (typeof ac !== 'string') continue;
        if (verifyOnlyPattern.test(ac) && !hasFiles) {
          errors.push(`acGroups[${i}]: AC 不得是纯验证步骤（无 files）: "${ac.slice(0, 60)}"`);
        }
      }
    }
  }

  for (const field of ['tags', 'constraints', 'discoveries'] as const) {
    const val = d.requirement ? (d.requirement as Record<string, unknown>)[field] : d[field];
    if (val !== undefined && !Array.isArray(val)) {
      errors.push(`${field} must be an array`);
    }
  }

  return errors;
}

describe('validateAnalystOutput (B5-H01)', () => {
  it('passes for valid output with all fields', () => {
    const doc: AnalystOutput = {
      title: 'Test Feature',
      acGroups: [{
        id: 'group-1 (auth)',
        acs: ['AC1: login works', 'AC2: logout works'],
        files: ['src/auth.ts'],
        dependencies: [],
        implementationNotes: 'Use JWT',
      }],
      tags: ['auth'],
      constraints: ['no breaking changes'],
      discoveries: ['found unused API'],
    };
    expect(validateAnalystOutput(doc)).toEqual([]);
  });

  it('passes for minimal valid output', () => {
    const doc = {
      acGroups: [{
        id: 'minimal',
        acs: ['do something'],
      }],
    };
    expect(validateAnalystOutput(doc)).toEqual([]);
  });

  it('fails for null input', () => {
    const errors = validateAnalystOutput(null);
    expect(errors).toContain('Output is not an object');
  });

  it('fails for non-object input', () => {
    const errors = validateAnalystOutput('string');
    expect(errors).toContain('Output is not an object');
  });

  it('fails for missing acGroups', () => {
    const errors = validateAnalystOutput({ title: 'test' });
    expect(errors).toContain('acGroups must be a non-empty array');
  });

  it('fails for empty acGroups', () => {
    const errors = validateAnalystOutput({ acGroups: [] });
    expect(errors).toContain('acGroups must be a non-empty array');
  });

  it('fails for acGroup missing id', () => {
    const errors = validateAnalystOutput({
      acGroups: [{ acs: ['test'] }],
    });
    expect(errors).toContain('acGroups[0].id must be a non-empty string');
  });

  it('fails for acGroup empty id', () => {
    const errors = validateAnalystOutput({
      acGroups: [{ id: '', acs: ['test'] }],
    });
    expect(errors).toContain('acGroups[0].id must be a non-empty string');
  });

  it('fails for acGroup missing acs', () => {
    const errors = validateAnalystOutput({
      acGroups: [{ id: 'group' }],
    });
    expect(errors).toContain('acGroups[0].acs must be a non-empty array');
  });

  it('fails for acGroup empty acs', () => {
    const errors = validateAnalystOutput({
      acGroups: [{ id: 'group', acs: [] }],
    });
    expect(errors).toContain('acGroups[0].acs must be a non-empty array');
  });

  it('fails for non-array files', () => {
    const errors = validateAnalystOutput({
      acGroups: [{ id: 'group', acs: ['test'], files: 'not-array' }],
    });
    expect(errors).toContain('acGroups[0].files must be an array');
  });

  it('fails for non-array dependencies', () => {
    const errors = validateAnalystOutput({
      acGroups: [{ id: 'group', acs: ['test'], dependencies: 'not-array' }],
    });
    expect(errors).toContain('acGroups[0].dependencies must be an array');
  });

  it('fails for non-array tags', () => {
    const errors = validateAnalystOutput({
      acGroups: [{ id: 'group', acs: ['test'] }],
      tags: 'not-array',
    });
    expect(errors).toContain('tags must be an array');
  });

  it('fails for non-array constraints', () => {
    const errors = validateAnalystOutput({
      acGroups: [{ id: 'group', acs: ['test'] }],
      constraints: 123,
    });
    expect(errors).toContain('constraints must be an array');
  });

  it('fails for non-array discoveries', () => {
    const errors = validateAnalystOutput({
      acGroups: [{ id: 'group', acs: ['test'] }],
      discoveries: {},
    });
    expect(errors).toContain('discoveries must be an array');
  });

  it('validates multiple acGroups', () => {
    const errors = validateAnalystOutput({
      acGroups: [
        { id: 'valid', acs: ['test'] },
        { id: '', acs: ['test'] },
        { acs: ['test'] },
      ],
    });
    expect(errors).toContain('acGroups[1].id must be a non-empty string');
    expect(errors).toContain('acGroups[2].id must be a non-empty string');
  });

  it('accepts acGroup with only required fields', () => {
    const errors = validateAnalystOutput({
      acGroups: [{ id: 'minimal', acs: ['one AC'] }],
    });
    expect(errors).toEqual([]);
  });

  // BT-4: AC-3 — contractTests 非空时，AC 不得含"写测试"指令
  it('BT-4: rejects AC with "写测试" when contractTests non-empty', () => {
    const errors = validateAnalystOutput({
      requirement: {
        acGroups: [{
          id: 'group-1',
          acs: ['在 src/auth.ts 添加 write test for login'],
          files: ['src/auth.ts'],
        }],
      },
      task: {
        acGroups: [{
          id: 'group-1',
          contractTests: [{ file: '__tests__/auth.test.ts', content: '...' }],
        }],
      },
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('AC 不得包含"写测试"指令'),
      ]),
    );
  });

  it('BT-4: rejects AC with "创建测试" (Chinese) when contractTests non-empty', () => {
    const errors = validateAnalystOutput({
      requirement: {
        acGroups: [{
          id: 'g', acs: ['创建测试文件'], files: ['src/x.ts'],
        }],
      },
      task: { acGroups: [{ id: 'g', contractTests: [{ file: 't.ts', content: 'x' }] }] },
    });
    expect(errors.some(e => e.includes('AC 不得包含"写测试"指令'))).toBe(true);
  });

  it('BT-4: allows "写测试" AC when contractTests is empty', () => {
    const errors = validateAnalystOutput({
      requirement: {
        acGroups: [{
          id: 'g', acs: ['在 src/auth.ts 写测试'], files: ['src/auth.ts'],
        }],
      },
      task: { acGroups: [{ id: 'g', contractTests: [] }] },
    });
    expect(errors.filter(e => e.includes('AC 不得包含"写测试"指令'))).toHaveLength(0);
  });

  // BT-5: AC-4 — 纯验证 AC（无 files）被拒绝
  it('BT-5: rejects pure verification AC without files', () => {
    const errors = validateAnalystOutput({
      acGroups: [{
        id: 'group-verify',
        acs: ['运行 tsc 和 vitest 验证所有测试通过'],
        // no files field
      }],
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('AC 不得是纯验证步骤'),
      ]),
    );
  });

  it('BT-5: rejects "跑测试" AC without files', () => {
    const errors = validateAnalystOutput({
      acGroups: [{
        id: 'g', acs: ['跑测试确认无回归'],
      }],
    });
    expect(errors.some(e => e.includes('AC 不得是纯验证步骤'))).toBe(true);
  });

  it('BT-5: allows verification AC when files present', () => {
    const errors = validateAnalystOutput({
      acGroups: [{
        id: 'g',
        acs: ['运行 tsc 验证'],
        files: ['src/x.ts'],
      }],
    });
    expect(errors.filter(e => e.includes('AC 不得是纯验证步骤'))).toHaveLength(0);
  });
});
