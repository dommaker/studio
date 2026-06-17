/**
 * RequirementGate Stage 2 deterministic check tests
 *
 * Verifies that Stage 2 uses deterministic rules, not LLM,
 * and that all Stage 2 checks are soft warnings (passed=true).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ──
vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../knowledge/knowledge-bus.service.js', () => ({
  sharedStore: { list: vi.fn(() => []) },
}));

import { validateRequirementsDoc } from '../requirement-gate.js';
import type { AcGroup } from '../requirement-gate.js';
import * as fs from 'fs';

// Stub fs.existsSync for file path checks
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn((p: string) => {
      // Pretend common paths exist
      if (typeof p === 'string' && (
        p.endsWith('.ts') || p.endsWith('.js') ||
        p.includes('apps/api') || p.includes('packages/')
      )) return true;
      return actual.existsSync(p);
    }),
  };
});

describe('RequirementGate Stage 2 deterministic checks', () => {
  const baseGroup = (overrides: Partial<AcGroup> = {}): AcGroup => ({
    id: 'group-a',
    acs: ['AC1: do something'],
    files: ['src/foo.ts'],
    dependencies: [],
    ...overrides,
  });

  it('passes when groups have no file overlap', async () => {
    const groups = [
      baseGroup({ id: 'a', files: ['src/foo.ts'] }),
      baseGroup({ id: 'b', files: ['src/bar.ts'] }),
    ];

    const result = await validateRequirementsDoc(groups, 'test', '/root/projects/studio');
    expect(result.passed).toBe(true);

    // Stage 2 should have summary check (all passed)
    const stage2Warnings = (result.stage2 || []).filter(c => c.name.includes('warning'));
    expect(stage2Warnings.length).toBe(0);
  });

  it('emits soft warning for file overlap without dependency', async () => {
    const groups = [
      baseGroup({ id: 'a', files: ['src/shared.ts'] }),
      baseGroup({ id: 'b', files: ['src/shared.ts'] }),
    ];

    const result = await validateRequirementsDoc(groups, 'test', '/root/projects/studio');
    expect(result.passed).toBe(true); // Still passes — warning only

    const warnings = (result.stage2 || []).filter(c => c.name === 'independence-warning');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0].passed).toBe(true); // soft warning
    expect(warnings[0].message).toContain('src/shared.ts');
  });

  it('no warning when overlapping groups have declared dependency', async () => {
    const groups = [
      baseGroup({ id: 'a', files: ['src/shared.ts'] }),
      baseGroup({ id: 'b', files: ['src/shared.ts'], dependencies: ['a'] }),
    ];

    const result = await validateRequirementsDoc(groups, 'test', '/root/projects/studio');
    expect(result.passed).toBe(true);

    const warnings = (result.stage2 || []).filter(c => c.name === 'independence-warning');
    expect(warnings.length).toBe(0); // Dependency declared, no warning
  });

  it('emits soft warning for one-way dependency', async () => {
    const groups = [
      baseGroup({ id: 'a', files: ['src/foo.ts'], dependencies: ['b'] }),
      baseGroup({ id: 'b', files: ['src/bar.ts'] }),
    ];

    const result = await validateRequirementsDoc(groups, 'test', '/root/projects/studio');
    expect(result.passed).toBe(true);

    const warnings = (result.stage2 || []).filter(c => c.name === 'one-way-dep-warning');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0].passed).toBe(true); // soft warning
  });

  it('emits soft warning for empty architectureContext fields', async () => {
    const groups = [
      baseGroup({
        id: 'a',
        architectureContext: {
          functions: [],
          callChain: '',
          imports: [],
          typesInScope: [],
          testMock: [],
          dangerZones: [],
          verifiedAt: '2026-01-01',
        },
      }),
    ];

    const result = await validateRequirementsDoc(groups, 'test', '/root/projects/studio');
    expect(result.passed).toBe(true);

    const warnings = (result.stage2 || []).filter(c => c.name === 'arch-ctx-warning');
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0].passed).toBe(true); // soft warning
    expect(warnings[0].message).toContain('functions');
  });

  it('never recommends upgrade-to-premium (Stage 2 is soft)', async () => {
    const groups = [
      baseGroup({ id: 'a', files: ['src/shared.ts'] }),
      baseGroup({ id: 'b', files: ['src/shared.ts'] }),
    ];

    const result = await validateRequirementsDoc(groups, 'test', '/root/projects/studio');
    expect(result.tierRecommendation).not.toBe('upgrade-to-premium');
  });
});
