// BT-9/BT-10: 波次分析算法单元测试
import { describe, it, expect, beforeEach } from 'vitest';
import {
  analyzeWaves,
  type WaveAC,
  getActiveSubAgentCount,
  canSpawnSubAgents,
  reserveSubAgentSlots,
  releaseSubAgentSlots,
} from '../scheduler-prompt.js';

describe('analyzeWaves (BT-9: 正确性)', () => {
  it('returns empty array for empty input', () => {
    expect(analyzeWaves([])).toEqual([]);
  });

  it('single AC → single wave', () => {
    const acs: WaveAC[] = [{ id: 'ac1', files: ['a.ts'] }];
    const waves = analyzeWaves(acs);
    expect(waves).toHaveLength(1);
    expect(waves[0]).toHaveLength(1);
    expect(waves[0][0].id).toBe('ac1');
  });

  it('two independent ACs (no file overlap, no deps) → one wave', () => {
    const acs: WaveAC[] = [
      { id: 'ac1', files: ['a.ts'] },
      { id: 'ac2', files: ['b.ts'] },
    ];
    const waves = analyzeWaves(acs);
    expect(waves).toHaveLength(1);
    expect(waves[0].map(a => a.id).sort()).toEqual(['ac1', 'ac2']);
  });

  it('two ACs with file overlap → two waves (serial)', () => {
    const acs: WaveAC[] = [
      { id: 'ac1', files: ['shared.ts'] },
      { id: 'ac2', files: ['shared.ts', 'other.ts'] },
    ];
    const waves = analyzeWaves(acs);
    expect(waves).toHaveLength(2);
    expect(waves[0]).toHaveLength(1);
    expect(waves[1]).toHaveLength(1);
  });

  it('AC with dependency on another → dependency placed first', () => {
    const acs: WaveAC[] = [
      { id: 'ac1', files: ['a.ts'] },
      { id: 'ac2', files: ['b.ts'], dependencies: ['ac1'] },
    ];
    const waves = analyzeWaves(acs);
    expect(waves).toHaveLength(2);
    expect(waves[0][0].id).toBe('ac1');
    expect(waves[1][0].id).toBe('ac2');
  });

  it('3 ACs: 2 independent + 1 dependent → 2 waves', () => {
    const acs: WaveAC[] = [
      { id: 'ac1', files: ['a.ts'] },
      { id: 'ac2', files: ['b.ts'] },
      { id: 'ac3', files: ['c.ts'], dependencies: ['ac1'] },
    ];
    const waves = analyzeWaves(acs);
    // ac1 + ac2 in wave 1 (independent), ac3 in wave 2 (depends on ac1)
    expect(waves).toHaveLength(2);
    expect(waves[0].map(a => a.id).sort()).toEqual(['ac1', 'ac2']);
    expect(waves[1][0].id).toBe('ac3');
  });

  it('3 ACs all overlapping → 3 waves (fully serial)', () => {
    const acs: WaveAC[] = [
      { id: 'ac1', files: ['shared.ts'] },
      { id: 'ac2', files: ['shared.ts'] },
      { id: 'ac3', files: ['shared.ts'] },
    ];
    const waves = analyzeWaves(acs);
    expect(waves).toHaveLength(3);
  });

  it('ignores dependencies on non-existent AC ids', () => {
    const acs: WaveAC[] = [
      { id: 'ac1', files: ['a.ts'], dependencies: ['non-existent'] },
    ];
    const waves = analyzeWaves(acs);
    expect(waves).toHaveLength(1);
  });
});

describe('analyzeWaves (BT-10: 循环依赖检测)', () => {
  it('throws on direct cycle: A → B → A', () => {
    const acs: WaveAC[] = [
      { id: 'a', files: ['a.ts'], dependencies: ['b'] },
      { id: 'b', files: ['b.ts'], dependencies: ['a'] },
    ];
    expect(() => analyzeWaves(acs)).toThrow(/循环依赖/);
  });

  it('throws on transitive cycle: A → B → C → A', () => {
    const acs: WaveAC[] = [
      { id: 'a', files: ['a.ts'], dependencies: ['b'] },
      { id: 'b', files: ['b.ts'], dependencies: ['c'] },
      { id: 'c', files: ['c.ts'], dependencies: ['a'] },
    ];
    expect(() => analyzeWaves(acs)).toThrow(/循环依赖/);
  });

  it('throws on self-cycle: A → A', () => {
    const acs: WaveAC[] = [
      { id: 'a', files: ['a.ts'], dependencies: ['a'] },
    ];
    expect(() => analyzeWaves(acs)).toThrow(/循环依赖/);
  });

  it('does not throw on diamond dependency (not a cycle)', () => {
    const acs: WaveAC[] = [
      { id: 'a', files: ['a.ts'] },
      { id: 'b', files: ['b.ts'], dependencies: ['a'] },
      { id: 'c', files: ['c.ts'], dependencies: ['a'] },
      { id: 'd', files: ['d.ts'], dependencies: ['b', 'c'] },
    ];
    const waves = analyzeWaves(acs);
    expect(waves.length).toBeGreaterThanOrEqual(2);
    // a first, b+c parallel, d last
    const flat = waves.flat().map(a => a.id);
    expect(flat.indexOf('a')).toBeLessThan(flat.indexOf('b'));
    expect(flat.indexOf('a')).toBeLessThan(flat.indexOf('c'));
    expect(flat.indexOf('d')).toBeGreaterThan(flat.indexOf('b'));
    expect(flat.indexOf('d')).toBeGreaterThan(flat.indexOf('c'));
  });
});

describe('sub-agent slot management (BT-15)', () => {
  beforeEach(() => {
    // Reset counter (release any residual)
    while (getActiveSubAgentCount() > 0) releaseSubAgentSlots(1);
  });

  it('initially can spawn up to MAX_SUB_AGENTS', () => {
    expect(canSpawnSubAgents(10)).toBe(true);
    expect(canSpawnSubAgents(11)).toBe(false);
  });

  it('reserve/release tracks count correctly', () => {
    reserveSubAgentSlots(5);
    expect(getActiveSubAgentCount()).toBe(5);
    expect(canSpawnSubAgents(5)).toBe(true);
    expect(canSpawnSubAgents(6)).toBe(false);
    releaseSubAgentSlots(3);
    expect(getActiveSubAgentCount()).toBe(2);
    expect(canSpawnSubAgents(8)).toBe(true);
  });

  it('release never goes below 0', () => {
    releaseSubAgentSlots(100);
    expect(getActiveSubAgentCount()).toBe(0);
  });
});
