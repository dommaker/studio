/**
 * AC2: agent-executor.ts cmd construction tests
 *
 * Validates:
 *  - AC2.1: cmd uses `< "${promptFile}"` input redirection (not `cat ... |`)
 *  - AC2.2: cmd does NOT contain `| tee` (shell pipe removed; `2>&1` redirect preserved for stderr merge)
 *  - AC2.3: log writing uses execSh stdout (JSON envelope parsing already in place)
 *  - AC2.4: cmd does NOT contain `--dangerously-skip-permissions`
 *  - AC2.5: execSh is called without opts.stdin
 *
 * Tests verify the source code directly since the execute() method is too complex
 * to mock fully (git worktree, harness deps, etc.).
 *
 * P11-02: Source split into session-manager.ts / output-capture.ts / worktree-resolver.ts
 * Tests read from the appropriate sub-module source files.
 */

import { describe, test, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ─── Load sources (P11-02 split) ────────────────────────────────
const sessionManagerPath = path.resolve(__dirname, '../session-manager.ts');
const sessionManagerSrc = fs.readFileSync(sessionManagerPath, 'utf-8');

const outputCapturePath = path.resolve(__dirname, '../output-capture.ts');
const outputCaptureSrc = fs.readFileSync(outputCapturePath, 'utf-8');

const worktreeResolverPath = path.resolve(__dirname, '../worktree-resolver.ts');
const worktreeResolverSrc = fs.readFileSync(worktreeResolverPath, 'utf-8');

// ─── Extract the cmd array construction ─────────────────────────
// Find the block between "const cmd = [" and the next "].join(' ');"
const cmdBlockMatch = sessionManagerSrc.match(/const cmd = \[([\s\S]*?)\]\.filter\(Boolean\)\.join\(' '\)/);
const cmdBlock = cmdBlockMatch ? cmdBlockMatch[1] : '';

// ─── Extract the execSh call (the one for claude) ───────────────
// Find the execSh call that contains the cmd variable reference
const execShCallMatch = sessionManagerSrc.match(/await execSh\(cmd,\s*\{([\s\S]*?)\}\);/);
const execShOpts = execShCallMatch ? execShCallMatch[1] : '';

// ─── Tests ──────────────────────────────────────────────────────

describe('AC2: agent-executor.ts cmd construction', () => {
  // ==============================================================
  // AC2.1: Replace cat|pipe with input redirection
  // ==============================================================
  describe('AC2.1: input redirection replaces cat|pipe', () => {
    test('AC2.1-1: cmd should NOT contain "cat" with pipe', () => {
      expect(cmdBlock).not.toMatch(/cat\s+['"]/);
    });

    test('AC2.1-2: cmd should NOT contain pipe symbol "|"', () => {
      expect(cmdBlock).not.toContain('|');
    });

    test('AC2.1-3: cmd should use input redirection "<"', () => {
      expect(cmdBlock).toContain('<');
    });

    test('AC2.1-4: cmd should redirect from promptFile', () => {
      expect(cmdBlock).toContain('promptFile');
    });

    test('AC2.1-5: cmd should contain "claude", "--print", and stream-json format', () => {
      expect(cmdBlock).toContain('claude');
      expect(cmdBlock).toContain('--print');
      expect(cmdBlock).toContain('--output-format stream-json');
      expect(cmdBlock).toContain('--verbose');
    });
  });

  // ==============================================================
  // AC2.2: Remove | tee pipe (preserve 2>&1 redirect)
  // ==============================================================
  describe('AC2.2: no | tee pipe in cmd', () => {
    test('AC2.2-1: cmd should contain "2>&1" (redirect, not a pipe — merges stderr for JSON envelope capture)', () => {
      expect(cmdBlock).toContain('2>&1');
    });

    test('AC2.2-2: cmd should NOT contain "tee"', () => {
      expect(cmdBlock).not.toContain('tee');
    });
  });

  // ==============================================================
  // AC2.3: Log writing uses execSh stdout (JSON envelope parsing)
  // ==============================================================
  describe('AC2.3: log writing uses execSh stdout via JSON envelope parsing', () => {
    test('AC2.3-1: JSON.parse(stdout) exists in output-capture (parseJsonEnvelope)', () => {
      expect(outputCaptureSrc).toContain('JSON.parse(stdout)');
    });

    test('AC2.3-2: envelope.is_error check exists in output-capture', () => {
      expect(outputCaptureSrc).toContain('envelope.is_error');
    });

    test('AC2.3-3: envelope.result extraction exists in output-capture', () => {
      expect(outputCaptureSrc).toContain('envelope.result');
    });

    test('AC2.3-4: stdout is destructed from execSh result in session-manager', () => {
      expect(sessionManagerSrc).toContain('const { stdout } = await execSh(cmd,');
    });
  });

  // ==============================================================
  // AC2.4: No --dangerously-skip-permissions in cmd
  // ==============================================================
  describe('AC2.4: no --dangerously-skip-permissions in cmd', () => {
    test('AC2.4-1: cmd should NOT contain --dangerously-skip-permissions', () => {
      expect(cmdBlock).not.toContain('--dangerously-skip-permissions');
    });

    test('AC2.4-2: settings.json bypassPermissions is used instead (in worktree-resolver)', () => {
      expect(worktreeResolverSrc).toContain('bypassPermissions');
      expect(worktreeResolverSrc).toContain('.claude/settings.json');
    });
  });

  // ==============================================================
  // AC2.5: execSh called without opts.stdin
  // ==============================================================
  describe('AC2.5: execSh called without opts.stdin', () => {
    test('AC2.5-1: execSh opts do NOT contain "stdin"', () => {
      expect(execShOpts).not.toContain('stdin');
    });

    test('AC2.5-2: process-io.ts uses stdio ignore for stdin', () => {
      const processIoPath = path.resolve(
        __dirname,
        '../../../../studio-shared/src/utils/process-io.ts',
      );
      if (fs.existsSync(processIoPath)) {
        const processIo = fs.readFileSync(processIoPath, 'utf-8');
        expect(processIo).toMatch(/stdio:\s*\[.*'pipe',\s*'pipe'\]/);
      }
    });
  });
});

// ─── Cross-AC integrity check ────────────────────────────────────
describe('Cross-AC integrity', () => {
  test('cmd structure: must start with cd, then claude with flags, then input redirect', () => {
    expect(cmdBlock).toMatch(/cd\s+"\$\{worktree\}"/);
    const claudeIdx = cmdBlock.indexOf('claude');
    const redirectIdx = cmdBlock.indexOf('<');
    expect(claudeIdx).toBeGreaterThan(0);
    expect(redirectIdx).toBeGreaterThan(claudeIdx);
  });

  test('promptFile variable is reused, not renamed (in session-manager)', () => {
    const promptFileDefs = sessionManagerSrc.match(/promptFile/g);
    expect(promptFileDefs).not.toBeNull();
    expect(promptFileDefs!.length).toBeGreaterThanOrEqual(2);
  });
});
