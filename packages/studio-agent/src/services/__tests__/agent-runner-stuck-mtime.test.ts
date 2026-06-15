/**
 * Stuck detection mtime whitelist — hasRecentActivity
 *
 * Problem: During npm/pnpm install, tsc compilation, or vitest runs,
 * completedSteps don't advance but the agent is waiting for I/O, not stuck.
 * Solution: Check file mtime in worktree before declaring stuck.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Resolve source path (same pattern as agent-runner.test.ts)
import { execSync } from 'child_process';

function resolveAgentRunnerSrc(): string {
  const local = path.resolve(__dirname, '../agent-runner.ts');
  if (fs.existsSync(local)) {
    const content = fs.readFileSync(local, 'utf-8');
    if (content.includes('hasRecentActivity')) return content;
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
        if (c.includes('hasRecentActivity')) return c;
      }
    }
  } catch { /* ignore */ }
  return fs.existsSync(local) ? fs.readFileSync(local, 'utf-8') : '';
}

const agentRunnerSrc = resolveAgentRunnerSrc();

// Import the function under test
// Will fail until GREEN phase implements it
import { hasRecentActivity } from '../agent-runner.js';

describe('hasRecentActivity', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtime-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns false for empty directory', () => {
    expect(hasRecentActivity(tmpDir)).toBe(false);
  });

  test('returns true when a file was modified within threshold', () => {
    const filePath = path.join(tmpDir, 'src', 'index.ts');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'console.log("hello")');
    expect(hasRecentActivity(tmpDir)).toBe(true);
  });

  test('returns false when all files are older than threshold', () => {
    const filePath = path.join(tmpDir, 'old-file.ts');
    fs.writeFileSync(filePath, 'old content');
    // Set mtime to 10 minutes ago
    const oldTime = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(filePath, oldTime, oldTime);
    expect(hasRecentActivity(tmpDir, 3 * 60 * 1000)).toBe(false);
  });

  test('ignores .progress.json (agent writes it regardless of progress)', () => {
    const progressFile = path.join(tmpDir, '.progress.json');
    fs.writeFileSync(progressFile, '{"completedSteps":[]}');
    // Only .progress.json exists — should return false
    expect(hasRecentActivity(tmpDir)).toBe(false);
  });

  test('ignores .agent.log', () => {
    const logFile = path.join(tmpDir, '.agent.log');
    fs.writeFileSync(logFile, 'some log output');
    expect(hasRecentActivity(tmpDir)).toBe(false);
  });

  test('ignores node_modules directory', () => {
    const nmDir = path.join(tmpDir, 'node_modules', 'some-pkg');
    fs.mkdirSync(nmDir, { recursive: true });
    fs.writeFileSync(path.join(nmDir, 'index.js'), 'module.exports = {}');
    expect(hasRecentActivity(tmpDir)).toBe(false);
  });

  test('detects activity in src/ subdirectory', () => {
    const srcFile = path.join(tmpDir, 'src', 'services', 'runner.ts');
    fs.mkdirSync(path.dirname(srcFile), { recursive: true });
    fs.writeFileSync(srcFile, 'export class Runner {}');
    expect(hasRecentActivity(tmpDir)).toBe(true);
  });

  test('respects custom thresholdMs parameter', () => {
    const filePath = path.join(tmpDir, 'recent.ts');
    fs.writeFileSync(filePath, 'content');
    // Set mtime to 2 minutes ago
    const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000);
    fs.utimesSync(filePath, twoMinAgo, twoMinAgo);
    // With 1-minute threshold, should be false
    expect(hasRecentActivity(tmpDir, 1 * 60 * 1000)).toBe(false);
    // With 5-minute threshold, should be true
    expect(hasRecentActivity(tmpDir, 5 * 60 * 1000)).toBe(true);
  });

  test('handles non-existent directory gracefully', () => {
    expect(hasRecentActivity('/nonexistent/path/xyz')).toBe(false);
  });
});

describe('Stuck detection integration: hasRecentActivity is called before declaring stuck', () => {
  test('agent-runner.ts exports hasRecentActivity function', () => {
    expect(agentRunnerSrc).toMatch(/export\s+function\s+hasRecentActivity/);
  });

  test('hasRecentActivity accepts worktreePath as first parameter', () => {
    expect(agentRunnerSrc).toMatch(/function\s+hasRecentActivity\s*\(\s*worktreePath\s*:\s*string/);
  });

  test('hasRecentActivity has default threshold of 3 minutes', () => {
    expect(agentRunnerSrc).toMatch(/hasRecentActivity\s*\([^)]*3\s*\*\s*60\s*\*\s*1000/);
  });

  test('hasRecentActivity excludes .progress.json from mtime check', () => {
    expect(agentRunnerSrc).toContain('.progress.json');
  });

  test('hasRecentActivity excludes .agent.log from mtime check', () => {
    expect(agentRunnerSrc).toContain('.agent.log');
  });

  test('hasRecentActivity excludes node_modules from mtime check', () => {
    expect(agentRunnerSrc).toContain('node_modules');
  });

  test('stuck detection path calls hasRecentActivity before incrementing stuckCount', () => {
    // The stuck detection block must call hasRecentActivity before stuckCount++
    expect(agentRunnerSrc).toMatch(/hasRecentActivity\s*\(\s*worktree/);
  });

  test('stuck detection defers when hasRecentActivity returns true', () => {
    // When hasRecentActivity returns true, stuckCount++ must be skipped
    // Look for: if (hasRecentActivity(worktree)) pattern near stuckCount
    expect(agentRunnerSrc).toMatch(/if\s*\(\s*hasRecentActivity\s*\(\s*worktree/);
  });
});
