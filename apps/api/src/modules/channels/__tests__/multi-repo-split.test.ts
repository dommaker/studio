/**
 * P3: Multi-repo Goal splitting tests
 *
 * When acGroups target different repos, split into separate Goal groups.
 */
import { describe, it, expect } from 'vitest';
import { splitAcGroupsByRepo } from '../multi-repo-split.js';

describe('splitAcGroupsByRepo', () => {
  it('returns single group when all acGroups target the same repo', () => {
    const acGroups = [
      { id: 'auth-login', acs: ['AC1'], files: [], dependencies: [], targetRepo: 'studio' },
      { id: 'auth-signup', acs: ['AC2'], files: [], dependencies: [], targetRepo: 'studio' },
    ];
    const result = splitAcGroupsByRepo(acGroups);
    expect(result).toHaveLength(1);
    expect(result[0].targetRepo).toBe('studio');
    expect(result[0].acGroups).toHaveLength(2);
  });

  it('splits into multiple groups when acGroups target different repos', () => {
    const acGroups = [
      { id: 'api-auth', acs: ['AC1'], files: [], dependencies: [], targetRepo: 'studio' },
      { id: 'harness-gate', acs: ['AC2'], files: [], dependencies: [], targetRepo: 'harness' },
    ];
    const result = splitAcGroupsByRepo(acGroups);
    expect(result).toHaveLength(2);
    expect(result[0].targetRepo).toBe('studio');
    expect(result[0].acGroups).toHaveLength(1);
    expect(result[1].targetRepo).toBe('harness');
    expect(result[1].acGroups).toHaveLength(1);
  });

  it('groups acGroups by targetRepo correctly', () => {
    const acGroups = [
      { id: 'a1', acs: [], files: [], dependencies: [], targetRepo: 'studio' },
      { id: 'a2', acs: [], files: [], dependencies: [], targetRepo: 'harness' },
      { id: 'a3', acs: [], files: [], dependencies: [], targetRepo: 'studio' },
      { id: 'a4', acs: [], files: [], dependencies: [], targetRepo: 'harness' },
      { id: 'a5', acs: [], files: [], dependencies: [], targetRepo: 'toolbox' },
    ];
    const result = splitAcGroupsByRepo(acGroups);
    expect(result).toHaveLength(3);
    expect(result.find(g => g.targetRepo === 'studio')?.acGroups).toHaveLength(2);
    expect(result.find(g => g.targetRepo === 'harness')?.acGroups).toHaveLength(2);
    expect(result.find(g => g.targetRepo === 'toolbox')?.acGroups).toHaveLength(1);
  });

  it('treats acGroups without targetRepo as "default" group', () => {
    const acGroups = [
      { id: 'a1', acs: [], files: [], dependencies: [], targetRepo: 'studio' },
      { id: 'a2', acs: [], files: [], dependencies: [] }, // no targetRepo
      { id: 'a3', acs: [], files: [], dependencies: [], targetRepo: undefined },
    ];
    const result = splitAcGroupsByRepo(acGroups);
    expect(result).toHaveLength(2);
    expect(result.find(g => g.targetRepo === 'studio')?.acGroups).toHaveLength(1);
    expect(result.find(g => g.targetRepo === '__default__')?.acGroups).toHaveLength(2);
  });

  it('returns empty array for empty input', () => {
    expect(splitAcGroupsByRepo([])).toEqual([]);
  });

  it('preserves acGroup order within each group', () => {
    const acGroups = [
      { id: 'first', acs: [], files: [], dependencies: [], targetRepo: 'studio' },
      { id: 'second', acs: [], files: [], dependencies: [], targetRepo: 'harness' },
      { id: 'third', acs: [], files: [], dependencies: [], targetRepo: 'studio' },
    ];
    const result = splitAcGroupsByRepo(acGroups);
    const studioGroup = result.find(g => g.targetRepo === 'studio');
    expect(studioGroup?.acGroups.map(g => g.id)).toEqual(['first', 'third']);
  });
});
