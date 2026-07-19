/**
 * analyst --max-turns per tier
 *
 * Source-code analysis: verify TIER_MAX_TURNS constant and --max-turns flag
 * are correctly wired into the lightweight session cmd array.
 * (Split: TIER constants + cmd construction in runner-params.ts, --max-turns wiring in runner-lightweight.ts)
 */

import { describe, test, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// TIER_MAX_TURNS / TIER_TIMEOUTS / --verbose cmd construction live in runner-params.ts
const runnerParamsSrc = fs.readFileSync(
  path.resolve(__dirname, '../runner-params.ts'),
  'utf-8',
);

// --max-turns wiring lives in runner-lightweight.ts
const runnerLightweightSrc = fs.readFileSync(
  path.resolve(__dirname, '../runner-lightweight.ts'),
  'utf-8',
);

describe('TIER_MAX_TURNS constant', () => {
  test('TIER_MAX_TURNS exists with correct values (fast=8, standard=15, premium=25)', () => {
    expect(runnerParamsSrc).toMatch(/const\s+TIER_MAX_TURNS\s*:\s*Record<ModelTier,\s*number>/);
    expect(runnerParamsSrc).toMatch(/fast:\s*8/);
    expect(runnerParamsSrc).toMatch(/standard:\s*15/);
    expect(runnerParamsSrc).toMatch(/premium:\s*25/);
  });

  test('TIER_MAX_TURNS placed near TIER_TIMEOUTS', () => {
    const tierTimeoutsIdx = runnerParamsSrc.indexOf('TIER_TIMEOUTS');
    const tierMaxTurnsIdx = runnerParamsSrc.indexOf('TIER_MAX_TURNS');
    expect(tierTimeoutsIdx).toBeGreaterThan(-1);
    expect(tierMaxTurnsIdx).toBeGreaterThan(-1);
    // Within 500 chars of each other
    expect(Math.abs(tierMaxTurnsIdx - tierTimeoutsIdx)).toBeLessThan(500);
  });
});

describe('--max-turns via buildSpawnArgs', () => {
  test('runner-lightweight calls buildSpawnArgs with maxTurns from parameters', () => {
    expect(runnerLightweightSrc).toMatch(/maxTurns.*task\.parameters/);
  });

  test('buildSpawnArgs in cli-adapter handles --max-turns for claude', () => {
    const cliAdapterPath = path.resolve(__dirname, '../../cli-adapter.ts');
    if (fs.existsSync(cliAdapterPath)) {
      const cliAdapterSrc = fs.readFileSync(cliAdapterPath, 'utf-8');
      expect(cliAdapterSrc).toMatch(/--max-turns/);
    }
  });

  test('--verbose remains in agent-runner cmd construction', () => {
    const verboseIdx = runnerParamsSrc.indexOf('`--verbose`');
    expect(verboseIdx).toBeGreaterThan(-1);
  });
});
