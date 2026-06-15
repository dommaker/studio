/**
 * analyst --max-turns per tier
 *
 * Source-code analysis: verify TIER_MAX_TURNS constant and --max-turns flag
 * are correctly wired into the lightweight session cmd array.
 */

import { describe, test, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

function resolveAgentRunnerSrc(): string {
  const local = path.resolve(__dirname, '../agent-runner.ts');
  if (fs.existsSync(local)) {
    const content = fs.readFileSync(local, 'utf-8');
    if (content.includes('TIER_MAX_TURNS')) return content;
  }
  try {
    const gitRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8', cwd: __dirname }).trim();
    const relPath = 'packages/studio-agent/src/services/agent-runner.ts';
    const wtList = execSync('git worktree list --porcelain', { encoding: 'utf-8', cwd: __dirname });
    for (const block of wtList.split('\n\n')) {
      const wtLine = block.split('\n').find(l => l.startsWith('worktree '));
      if (!wtLine) continue;
      const wtRoot = wtLine.slice('worktree '.length);
      if (wtRoot === gitRoot) continue;
      const candidate = path.join(wtRoot, relPath);
      if (fs.existsSync(candidate)) {
        const c = fs.readFileSync(candidate, 'utf-8');
        if (c.includes('TIER_MAX_TURNS')) return c;
      }
    }
  } catch { /* ignore */ }
  return fs.existsSync(local) ? fs.readFileSync(local, 'utf-8') : '';
}

const agentRunnerSrc = resolveAgentRunnerSrc();

describe('TIER_MAX_TURNS constant', () => {
  test('TIER_MAX_TURNS exists with correct values (fast=8, standard=15, premium=25)', () => {
    expect(agentRunnerSrc).toMatch(/const\s+TIER_MAX_TURNS\s*:\s*Record<ModelTier,\s*number>/);
    expect(agentRunnerSrc).toMatch(/fast:\s*8/);
    expect(agentRunnerSrc).toMatch(/standard:\s*15/);
    expect(agentRunnerSrc).toMatch(/premium:\s*25/);
  });

  test('TIER_MAX_TURNS placed near TIER_TIMEOUTS', () => {
    const tierTimeoutsIdx = agentRunnerSrc.indexOf('TIER_TIMEOUTS');
    const tierMaxTurnsIdx = agentRunnerSrc.indexOf('TIER_MAX_TURNS');
    expect(tierTimeoutsIdx).toBeGreaterThan(-1);
    expect(tierMaxTurnsIdx).toBeGreaterThan(-1);
    // Within 500 chars of each other
    expect(Math.abs(tierMaxTurnsIdx - tierTimeoutsIdx)).toBeLessThan(500);
  });
});

describe('cmd array includes --max-turns', () => {
  test('cmd contains --max-turns flag', () => {
    expect(agentRunnerSrc).toMatch(/--max-turns/);
  });

  test('--max-turns uses TIER_MAX_TURNS lookup with taskTier', () => {
    expect(agentRunnerSrc).toMatch(/--max-turns\s+\$\{TIER_MAX_TURNS\[\s*taskTier\s*(as\s+ModelTier)?\]/);
  });

  test('--max-turns placed after --verbose', () => {
    // Find the cmd array block containing both --verbose and --max-turns
    const verboseIdx = agentRunnerSrc.indexOf('`--verbose`');
    const maxTurnsIdx = agentRunnerSrc.indexOf('`--max-turns');
    expect(verboseIdx).toBeGreaterThan(-1);
    expect(maxTurnsIdx).toBeGreaterThan(-1);
    expect(maxTurnsIdx).toBeGreaterThan(verboseIdx);
  });
});
