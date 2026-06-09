#!/usr/bin/env python3
"""Pipeline Fix Script — apply all known fixes atomically.
Run from /root/projects/studio: python3 fix-pipeline.py
"""
import re, os, sys

GOALS_DIR = "apps/api/src/modules/goals"
REPO_DIR = "/root/projects/studio"

def read_file(path):
    with open(path, 'r') as f:
        return f.read()

def write_file(path, content):
    with open(path, 'w') as f:
        f.write(content)

def fix_scheduler_dispatch():
    path = os.path.join(GOALS_DIR, "scheduler-dispatch.ts")
    content = read_file(path)
    fixes = 0

    # Fix 1: branch fallback — `task/${_baseBranchExecId}` → 'master'
    old = "findTaskBranch(_baseBranchExecId, projectRepoDir) || `task/${_baseBranchExecId}`"
    new = "findTaskBranch(_baseBranchExecId, projectRepoDir) || 'master'"
    if old in content:
        content = content.replace(old, new)
        fixes += 1
        print("  [1] Branch fallback: use 'master' instead of non-existent task/ branch")

    # Fix 2: headCommit storage in handleDispatchSuccess
    if "headCommit" not in content:
        # Find the handleDispatchSuccess function and add headCommit capture
        old_block = """  const worktreeDir = path.join(WORKTREES_DIR, executionId);
  const execOutput = (result as any).output || (result as any).stdout?.slice(0, 5000);
  await goalService.updateStepExecution(executionId, {
    status: 'succeeded',
    ...(execOutput ? { output: execOutput } : {}),
  });"""
        new_block = """  const worktreeDir = path.join(WORKTREES_DIR, executionId);
  const execOutput = (result as any).output || (result as any).stdout?.slice(0, 5000);

  // Capture HEAD commit SHA for integration step to use
  let headCommit: string | undefined;
  try {
    const { execSync: execSyncLocal } = await import('child_process');
    headCommit = execSyncLocal('git rev-parse HEAD', { cwd: worktreeDir, encoding: 'utf-8', timeout: 5_000, stdio: 'pipe' }).trim();
  } catch { /* worktree may be cleaned up */ }

  const outputData: Record<string, unknown> = {};
  if (execOutput) {
    try { Object.assign(outputData, JSON.parse(execOutput)); } catch { outputData.raw = execOutput; }
  }
  if (headCommit) outputData.headCommit = headCommit;

  await goalService.updateStepExecution(executionId, {
    status: 'succeeded',
    ...(Object.keys(outputData).length > 0 ? { output: JSON.stringify(outputData) } : {}),
  });"""
        if old_block in content:
            content = content.replace(old_block, new_block)
            fixes += 1
            print("  [2] headCommit storage added to handleDispatchSuccess")

    write_file(path, content)
    return fixes

def fix_scheduler_prompt():
    path = os.path.join(GOALS_DIR, "scheduler-prompt.ts")
    content = read_file(path)
    fixes = 0

    # Fix 3: dist/ copy + prisma generate before tsc
    if "Copy built dist/" not in content:
        old_tsc = """  try {
    execSync('npx tsc --noEmit --project apps/api/tsconfig.json 2>&1', { cwd: worktree, timeout: 60_000 });"""
        new_tsc = """  // Copy built dist/ from main repo — worktree packages are gitignored, no dist/
  try {
    const mainPackagesDir = path.join(repoDir, 'packages');
    const wtPackagesDir = path.join(worktree, 'packages');
    if (fs.existsSync(mainPackagesDir) && fs.existsSync(wtPackagesDir)) {
      for (const pkg of fs.readdirSync(mainPackagesDir)) {
        const mainDist = path.join(mainPackagesDir, pkg, 'dist');
        const wtDist = path.join(wtPackagesDir, pkg, 'dist');
        if (fs.existsSync(mainDist) && !fs.existsSync(wtDist)) {
          execSync(`cp -r "${mainDist}" "${wtDist}"`, { timeout: 10_000 });
        }
      }
    }
    // Also copy harness dist/ (sibling repo, linked via pnpm overrides)
    const mainHarnessDist = path.join(repoDir, '..', 'harness', 'dist');
    const wtHarnessDist = path.join(worktree, 'harness', 'dist');
    if (fs.existsSync(mainHarnessDist) && !fs.existsSync(wtHarnessDist)) {
      execSync(`cp -r "${mainHarnessDist}" "${wtHarnessDist}"`, { timeout: 10_000 });
    }
  } catch (e) {
    logger.warn('[GoalScheduler] Failed to copy workspace dist/', { error: String(e) });
  }

  // Generate Prisma client — pnpm store may have stale types
  try {
    execSync('npx prisma generate 2>&1', { cwd: path.join(worktree, 'packages', 'studio-prisma'), timeout: 30_000 });
  } catch (e) {
    logger.warn('[GoalScheduler] prisma generate failed', { error: String(e) });
  }

  try {
    execSync('npx tsc --noEmit --project apps/api/tsconfig.json 2>&1', { cwd: worktree, timeout: 60_000 });"""
        if old_tsc in content:
            content = content.replace(old_tsc, new_tsc)
            fixes += 1
            print("  [3] dist/ copy + prisma generate added before tsc")

    # Fix 4: headCommit fallback in branch lookup
    if "headCommit" not in content:
        # Add headCommit fallback after branch lookup fails
        old_merge = """    if (!branchExists) {
      missingBranches.push(`step ${exec.stepIndex} (${exec.id.slice(0, 8)})`);
      continue;
    }"""
        new_merge = """    // Fallback: use stored headCommit from execution output
    if (!branchExists) {
      try {
        const output = typeof exec.output === 'string' ? JSON.parse(exec.output) : (exec.output || {});
        const sha = output?.headCommit;
        if (sha) {
          execSync(`git cat-file -t "${sha}"`, { cwd: worktree, timeout: 5_000, stdio: 'pipe' });
          branch = sha;
          branchExists = true;
          logger.info('[GoalScheduler] Using stored headCommit for merge', { executionId: exec.id, sha });
        }
      } catch { /* SHA not available or not valid */ }
    }
    if (!branchExists) {
      missingBranches.push(`step ${exec.stepIndex} (${exec.id.slice(0, 8)})`);
      continue;
    }"""
        if old_merge in content:
            content = content.replace(old_merge, new_merge)
            fixes += 1
            print("  [4] headCommit fallback added for branch lookup")

    write_file(path, content)
    return fixes

def fix_scheduler_integration():
    path = os.path.join(GOALS_DIR, "scheduler-integration.ts")
    content = read_file(path)
    fixes = 0

    # Fix 5: disable abandonOrphanedRunning
    if "abandonOrphanedRunning disabled" not in content:
        old = """    this.abandonOrphanedRunning().catch(e => {
      logger.error('[GoalScheduler] Abandon orphaned failed', { error: String(e) });
    });"""
        new = """    // abandonOrphanedRunning disabled — recoverStaleExecutions handles stale executions with grace period
    // this.abandonOrphanedRunning().catch(e => {
    //   logger.error('[GoalScheduler] Abandon orphaned failed', { error: String(e) });
    // });"""
        if old in content:
            content = content.replace(old, new)
            fixes += 1
            print("  [5] abandonOrphanedRunning disabled")

    write_file(path, content)
    return fixes

def fix_goal_lifecycle():
    path = os.path.join(GOALS_DIR, "goal-lifecycle.ts")
    content = read_file(path)
    fixes = 0

    # Fix 6: only cleanup on success, and defer during review-fix cycles
    if "Only on final success" not in content:
        old = """  // Cleanup executor worktrees and task branches (non-blocking)
  cleanupGoalWorktrees(goalId).catch(err =>
    logger.warn('[Goal] Worktree cleanup failed (non-blocking)', { goalId, error: String(err) })
  );"""
        new = """  // Cleanup executor worktrees and task branches (non-blocking)
  // Only on final success — after review approves (not during review-fix cycles)
  // Defer cleanup: re-check goal status after handleGoalSucceeded may have dispatched review-fix
  if (newStatus === 'succeeded') {
    const currentGoal = await prisma.goal.findUnique({ where: { id: goalId }, select: { status: true } });
    if (currentGoal?.status === 'succeeded') {
      cleanupGoalWorktrees(goalId).catch(err =>
        logger.warn('[Goal] Worktree cleanup failed (non-blocking)', { goalId, error: String(err) })
      );
    } else {
      logger.info('[Goal] Skipping worktree cleanup — review cycle pending', { goalId, currentStatus: currentGoal?.status });
    }
  }"""
        if old in content:
            content = content.replace(old, new)
            fixes += 1
            print("  [6] Cleanup guard: defer during review-fix cycles")

    write_file(path, content)
    return fixes

def fix_goal_review():
    path = os.path.join(GOALS_DIR, "goal-review.ts")
    content = read_file(path)
    fixes = 0

    # Fix 7: remove 'error' field from Goal update (Goal model has no 'error' column)
    old = "data: { status: 'blocked', error: 'No review worktree found after execution completion. Possible causes: cleanup ran prematurely, WORKTREES_DIR misconfiguration, or worktree creation failed.' },"
    new = "data: { status: 'blocked' },"
    if old in content:
        content = content.replace(old, new)
        fixes += 1
        print("  [7] Removed invalid 'error' field from Goal update in goal-review.ts")

    write_file(path, content)
    return fixes

def main():
    os.chdir(REPO_DIR)
    print("=== Pipeline Fix Script ===")
    print(f"Working directory: {os.getcwd()}")
    print()

    total = 0
    total += fix_scheduler_dispatch()
    total += fix_scheduler_prompt()
    total += fix_scheduler_integration()
    total += fix_goal_lifecycle()
    total += fix_goal_review()

    print(f"\n=== {total} fixes applied ===")
    print("Run 'python3 fix-pipeline.py' to re-apply if files get reverted.")

if __name__ == "__main__":
    main()
