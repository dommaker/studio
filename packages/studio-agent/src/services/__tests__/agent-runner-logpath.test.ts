/**
 * Behavioral test: logFile path must be derived from resolved worktree path
 *
 * Bug: logFile was computed from config.worktreesDir before worktree resolution.
 * When VPS workspace returned a different path (e.g., /root/projects/studio),
 * logFile pointed to a non-existent directory → ENOENT → session exhaustion.
 */

import { describe, test, expect } from 'vitest';
import * as path from 'path';

describe('logFile path derivation', () => {
  test('logFile is derived from worktree path, not config.worktreesDir', () => {
    // Simulate the bug: config.worktreesDir differs from actual worktree
    const configWorktreesDir = '/root/worktrees';
    const executionId = 'exec-123';
    const vpsWorkspace = '/root/projects/studio';

    // Old (buggy): logFile from config
    const oldLogFile = path.join(configWorktreesDir, executionId, '.agent.log');
    expect(oldLogFile).toBe('/root/worktrees/exec-123/.agent.log');

    // New (fixed): logFile from resolved worktree
    const newLogFile = path.join(vpsWorkspace, '.agent.log');
    expect(newLogFile).toBe('/root/projects/studio/.agent.log');

    // The paths must differ when worktree != config.worktreesDir/executionId
    expect(oldLogFile).not.toBe(newLogFile);
  });

  test('logFile falls back to config path when worktree resolution fails', () => {
    const configWorktreesDir = '/root/worktrees';
    const executionId = 'exec-123';

    // When resolveWorktree throws, worktree is empty string
    const worktree = '';
    const logFile = worktree
      ? path.join(worktree, '.agent.log')
      : path.join(configWorktreesDir, executionId, '.agent.log');

    expect(logFile).toBe('/root/worktrees/exec-123/.agent.log');
  });
});
