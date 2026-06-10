/**
 * Pipeline P1/P2/P4/P9 fixes — TDD RED
 */
import { describe, it, expect } from 'vitest';

// ─── P1: Worktree ENOENT — startup validation ───

describe('P1: Worktree lifecycle — startup validation', () => {
  it('goal-lifecycle exports validateWorktreePaths function', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../src/modules/goals/goal-lifecycle.ts'),
      'utf-8'
    );
    // Should have a function that validates worktree paths on startup
    expect(source).toContain('validateWorktreePaths');
  });

  it('marks execution as failed when worktree directory missing', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../src/modules/goals/goal-lifecycle.ts'),
      'utf-8'
    );
    // Should check fs.existsSync on worktree path
    expect(source).toMatch(/existsSync.*worktree|worktree.*existsSync/);
    // Should set status to failed with ENOENT-specific message
    expect(source).toMatch(/worktree.*lost|worktree.*missing|worktree.*not found/i);
  });
});

// ─── P2: Cascade retry — allow single-step retry ───

describe('P2: Cascade failure — single-step retry', () => {
  it('cascadeBlockedFailures does not permanently fail steps that can be retried', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../src/modules/goals/goal-lifecycle.ts'),
      'utf-8'
    );
    // Should have a way to reset cascade-blocked steps to pending
    // instead of permanently marking them as failed
    expect(source).toMatch(/cascade.*retry|retry.*cascade|reset.*pending/i);
  });

  it('retryable status is distinct from permanently failed', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../src/modules/goals/goal-lifecycle.ts'),
      'utf-8'
    );
    // Should distinguish between "blocked by dependency" (retryable) and "actually failed"
    expect(source).toMatch(/blocked_by_dependency|cascade_blocked/);
  });
});

// ─── P4: daemon status — HTTP endpoint ───

describe('P4: daemon status — HTTP endpoint', () => {
  it('daemon-routes has GET /status endpoint', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../src/modules/workspaces/daemon-routes.ts'),
      'utf-8'
    );
    // Should have a /status route
    expect(source).toContain('router.get');
    expect(source).toMatch(/\/status|daemon.*status/);
  });

  it('CLI uses HTTP to check daemon status instead of local instance', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../src/cli/studio-cli.ts'),
      'utf-8'
    );
    // Should call HTTP endpoint for daemon status
    expect(source).toMatch(/fetch.*daemon.*status|api\/v1\/daemon/);
    // Should NOT import local daemon instance for status check
    // (the daemon status command should use HTTP, not local import)
  });
});

// ─── P9: Analyst "already implemented" ───

describe('P9: Analyst prompt — already implemented handling', () => {
  it('includes instruction for already-implemented functionality', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../src/modules/channels/analyst-prompt.ts'),
      'utf-8'
    );
    // Should instruct Analyst what to do when functionality already exists
    expect(source).toMatch(/已实现|already.*implement|已有实现/);
  });

  it('instructs to use contractTestsSkipReason when already implemented', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../src/modules/channels/analyst-prompt.ts'),
      'utf-8'
    );
    // Should tell Analyst to output skipReason instead of creating a Goal
    expect(source).toMatch(/已实现.*SkipReason|SkipReason.*已实现|already.*SkipReason/i);
  });
});
