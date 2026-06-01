// B5-H01: Analyst 输出 JSON Schema 验证测试
import { describe, it, expect } from 'vitest';

// 直接测试验证逻辑（不依赖外部模块）
interface AnalystOutput {
  title?: string;
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

  if (d.title !== undefined && typeof d.title !== 'string') {
    errors.push('title must be a string');
  }

  if (!Array.isArray(d.acGroups) || d.acGroups.length === 0) {
    errors.push('acGroups must be a non-empty array');
  } else {
    for (let i = 0; i < d.acGroups.length; i++) {
      const g = d.acGroups[i];
      if (!g || typeof g !== 'object') { errors.push(`acGroups[${i}] must be an object`); continue; }
      if (typeof g.id !== 'string' || !g.id.trim()) errors.push(`acGroups[${i}].id must be a non-empty string`);
      if (!Array.isArray(g.acs) || g.acs.length === 0) errors.push(`acGroups[${i}].acs must be a non-empty array`);
      if (g.files !== undefined && !Array.isArray(g.files)) errors.push(`acGroups[${i}].files must be an array`);
      if (g.dependencies !== undefined && !Array.isArray(g.dependencies)) errors.push(`acGroups[${i}].dependencies must be an array`);
    }
  }

  for (const field of ['tags', 'constraints', 'discoveries'] as const) {
    if (d[field] !== undefined && !Array.isArray(d[field])) {
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
});
