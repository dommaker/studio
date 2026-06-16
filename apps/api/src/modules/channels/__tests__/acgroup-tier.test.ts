/**
 * AC Group modelTier inheritance tests
 */
import { describe, it, expect } from 'vitest';
import { ensureModelTierInheritance, type AcGroupWithTier } from '../acgroup-tier.js';

function makeGroup(overrides: Partial<AcGroupWithTier> & { id: string; acs: string[] }): AcGroupWithTier {
  return { files: [], dependencies: [], ...overrides };
}

describe('ensureModelTierInheritance', () => {
  it('inherits taskTier into acGroups without modelTier', () => {
    const groups = [
      makeGroup({ id: 'g1', acs: ['AC1'] }),
      makeGroup({ id: 'g2', acs: ['AC2', 'AC3'] }),
    ];
    const summary = ensureModelTierInheritance(groups, 'fast');

    expect(groups[0].modelTier).toBe('fast');
    expect(groups[1].modelTier).toBe('fast');
    expect(summary.tier).toBe('fast');
    expect(summary.acGroupCount).toBe(2);
    expect(summary.totalAcs).toBe(3);
  });

  it('does not override acGroup that already has modelTier', () => {
    const groups = [
      makeGroup({ id: 'g1', acs: ['AC1'], modelTier: 'premium' }),
      makeGroup({ id: 'g2', acs: ['AC2'] }),
    ];
    ensureModelTierInheritance(groups, 'fast');

    expect(groups[0].modelTier).toBe('premium');
    expect(groups[1].modelTier).toBe('fast');
  });

  it('handles empty acGroups array', () => {
    const summary = ensureModelTierInheritance([], 'fast');
    expect(summary.acGroupCount).toBe(0);
    expect(summary.totalAcs).toBe(0);
    expect(summary.parallelizable).toBe(0);
  });

  it('does nothing when taskTier is undefined', () => {
    const groups = [makeGroup({ id: 'g1', acs: ['AC1'] })];
    ensureModelTierInheritance(groups, undefined);
    expect(groups[0].modelTier).toBeUndefined();
  });

  it('does nothing when taskTier is invalid', () => {
    const groups = [makeGroup({ id: 'g1', acs: ['AC1'] })];
    ensureModelTierInheritance(groups, 'ultra-fast');
    expect(groups[0].modelTier).toBeUndefined();
  });

  it('computes parallelizable vs withDependencies correctly', () => {
    const groups = [
      makeGroup({ id: 'g1', acs: ['AC1'], dependencies: [] }),
      makeGroup({ id: 'g2', acs: ['AC2'], dependencies: ['g1'] }),
      makeGroup({ id: 'g3', acs: ['AC3'] }),
    ];
    const summary = ensureModelTierInheritance(groups, 'standard');

    expect(summary.parallelizable).toBe(2); // g1, g3
    expect(summary.withDependencies).toBe(1); // g2
  });

  it('produces correct modelTiers summary string', () => {
    const groups = [
      makeGroup({ id: 'auth', acs: ['AC1'], modelTier: 'premium' }),
      makeGroup({ id: 'ui', acs: ['AC2'] }),
    ];
    const summary = ensureModelTierInheritance(groups, 'fast');
    expect(summary.modelTiers).toBe('auth:premium, ui:fast');
  });

  it('defaults modelTier to "standard" in summary when unset and no taskTier', () => {
    const groups = [makeGroup({ id: 'g1', acs: ['AC1'] })];
    const summary = ensureModelTierInheritance(groups, undefined);
    expect(summary.modelTiers).toBe('g1:standard');
  });
});
