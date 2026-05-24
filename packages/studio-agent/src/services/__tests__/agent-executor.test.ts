/**
 * AC2: agent-executor.ts cmd construction tests
 *
 * Validates:
 *  - AC2.1: cmd uses `< "${promptFile}"` input redirection (not `cat ... |`)
 *  - AC2.2: cmd does NOT contain `2>&1 | tee -a`
 *  - AC2.3: log writing uses execSh stdout (JSON envelope parsing already in place)
 *  - AC2.4: cmd does NOT contain `--dangerously-skip-permissions`
 *  - AC2.5: execSh is called without opts.stdin
 *
 * Tests verify the source code directly since the execute() method is too complex
 * to mock fully (git worktree, harness deps, etc.).
 */

import { describe, test, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ─── Load source ─────────────────────────────────────────────────
const sourcePath = path.resolve(__dirname, '../agent-executor.ts');
const source = fs.readFileSync(sourcePath, 'utf-8');

// ─── Extract the cmd array construction (lines ~278-288) ─────────
// Find the block between "const cmd = [" and the next "].join(' ');"
const cmdBlockMatch = source.match(/const cmd = \[([\s\S]*?)\]\.join\(' '\)/);
const cmdBlock = cmdBlockMatch ? cmdBlockMatch[1] : '';

// ─── Extract the execSh call (the one for claude, near line 305) ──
// Find the execSh call that contains the cmd variable reference
const execShCallMatch = source.match(/await execSh\(cmd,\s*\{([\s\S]*?)\}\);/);
const execShOpts = execShCallMatch ? execShCallMatch[1] : '';

// ─── Tests ──────────────────────────────────────────────────────

describe('AC2: agent-executor.ts cmd construction', () => {
  // ==============================================================
  // AC2.1: Replace cat|pipe with input redirection
  // ==============================================================
  describe('AC2.1: input redirection replaces cat|pipe', () => {
    test('AC2.1-1: cmd should NOT contain "cat" with pipe', () => {
      // Current code uses: cat '${promptFile}' |
      // After fix: `< "${promptFile}"`
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

    test('AC2.1-5: cmd should contain "claude" and "--print" (preserved flags)', () => {
      expect(cmdBlock).toContain('claude');
      expect(cmdBlock).toContain('--print');
      expect(cmdBlock).toContain('--output-format json');
    });
  });

  // ==============================================================
  // AC2.2: Remove 2>&1 | tee -a
  // ==============================================================
  describe('AC2.2: no 2>&1 | tee in cmd', () => {
    test('AC2.2-1: cmd should NOT contain "2>&1"', () => {
      expect(cmdBlock).not.toContain('2>&1');
    });

    test('AC2.2-2: cmd should NOT contain "tee"', () => {
      expect(cmdBlock).not.toContain('tee');
    });
  });

  // ==============================================================
  // AC2.3: Log writing uses execSh stdout (JSON envelope parsing)
  // ==============================================================
  describe('AC2.3: log writing uses execSh stdout via JSON envelope parsing', () => {
    test('AC2.3-1: JSON.parse(stdout) exists for envelope extraction', () => {
      expect(source).toContain('JSON.parse(stdout)');
    });

    test('AC2.3-2: envelope.is_error check exists', () => {
      expect(source).toContain('envelope.is_error');
    });

    test('AC2.3-3: envelope.result extraction exists', () => {
      expect(source).toContain('envelope.result');
    });

    test('AC2.3-4: stdout is destructed from execSh result', () => {
      expect(source).toContain('const { stdout } = await execSh(cmd,');
    });
  });

  // ==============================================================
  // AC2.4: No --dangerously-skip-permissions in cmd
  // ==============================================================
  describe('AC2.4: no --dangerously-skip-permissions in cmd', () => {
    test('AC2.4-1: cmd should NOT contain --dangerously-skip-permissions', () => {
      expect(cmdBlock).not.toContain('--dangerously-skip-permissions');
    });

    test('AC2.4-2: settings.json bypassPermissions is used instead (line 167-174)', () => {
      expect(source).toContain('bypassPermissions');
      expect(source).toContain('.claude/settings.json');
    });
  });

  // ==============================================================
  // AC2.5: execSh called without opts.stdin
  // ==============================================================
  describe('AC2.5: execSh called without opts.stdin', () => {
    test('AC2.5-1: execSh opts do NOT contain "stdin"', () => {
      // execSh in process-io.ts:52 always uses stdio: ['ignore', 'pipe', 'pipe']
      // The call site should not attempt to pass stdin in opts
      expect(execShOpts).not.toContain('stdin');
    });

    test('AC2.5-2: process-io.ts uses stdio ignore for stdin', () => {
      const processIoPath = path.resolve(
        __dirname,
        '../../../../studio-shared/src/utils/process-io.ts',
      );
      if (fs.existsSync(processIoPath)) {
        const processIo = fs.readFileSync(processIoPath, 'utf-8');
        expect(processIo).toContain("stdio: ['ignore', 'pipe', 'pipe']");
      }
    });
  });
});

// ─── Cross-AC integrity check ────────────────────────────────────
describe('Cross-AC integrity', () => {
  test('cmd structure: must start with cd, then claude with flags, then input redirect', () => {
    // The cmd array should follow the canonical order:
    // cd → claude → --print → --output-format → sessionFlag → < → promptFile
    expect(cmdBlock).toMatch(/cd\s+"\$\{worktree\}"/);
    // claude appears before the redirect
    const claudeIdx = cmdBlock.indexOf('claude');
    const redirectIdx = cmdBlock.indexOf('<');
    expect(claudeIdx).toBeGreaterThan(0);
    expect(redirectIdx).toBeGreaterThan(claudeIdx);
  });

  test('promptFile variable is reused (line 274), not renamed', () => {
    // promptFile is defined at line 274 — the cmd block references it directly
    const promptFileDefs = source.match(/promptFile/g);
    expect(promptFileDefs).not.toBeNull();
    // Should be referenced at least twice: once for definition, once in cmd
    expect(promptFileDefs!.length).toBeGreaterThanOrEqual(2);
  });
});
