import { describe, it, expect } from 'vitest';
import { deriveDisplayState, parseAttestations, type DerivedWuState } from '../web';

describe('web entrypoint', () => {
  it('re-exports attestation module (deriveDisplayState)', () => {
    const result = deriveDisplayState({ status: 'done', metadata: null });
    expect(result).toBeDefined();
    expect(result.column).toBe('done');
    expect(result.hasAttestations).toBe(false);
  });

  it('re-exports parseAttestations', () => {
    expect(parseAttestations(undefined)).toBeUndefined();
    expect(parseAttestations({ attestations: { l3: { verdict: 'approved', by: 'human', at: 't', kind: 'human-confirm' } } })?.l3?.verdict).toBe('approved');
  });

  it('DerivedWuState type is available (compile-time)', () => {
    const state: DerivedWuState = deriveDisplayState({ status: 'active' });
    expect(state.evidence.l1).toBe(false);
  });
});
