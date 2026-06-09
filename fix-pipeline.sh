#!/bin/bash
# Pipeline Fix Script — apply all known fixes atomically
# Run from /root/projects/studio
set -euo pipefail

GOALS_DIR="apps/api/src/modules/goals"

echo "=== Pipeline Fix Script ==="
echo "Fixing 7 known issues in $GOALS_DIR"

# ─── Fix 1: scheduler-dispatch.ts:272 — branch fallback ───
# Change `task/${_baseBranchExecId}` to `'master'` when branch not found
sed -i "s|findTaskBranch(_baseBranchExecId, projectRepoDir) || \`task/\${_baseBranchExecId}\`|findTaskBranch(_baseBranchExecId, projectRepoDir) || 'master'|g" \
  "$GOALS_DIR/scheduler-dispatch.ts"
echo "[1/7] Branch fallback fixed (use 'master' instead of non-existent task/ branch)"

# ─── Fix 2: scheduler-prompt.ts — merge conflict variable name ───
# The loop variable is `branch` again (was `mergeRef` in our edit), so this is already correct
# But verify: if `mergeRef` is the loop var, fix references; if `branch`, it's fine
if grep -q "let mergeRef" "$GOALS_DIR/scheduler-prompt.ts"; then
  sed -i 's/{ branch, error:/{ branch: mergeRef, error:/g' "$GOALS_DIR/scheduler-prompt.ts"
  sed -i 's/{ branch, executionId/{ branch: mergeRef, executionId/g' "$GOALS_DIR/scheduler-prompt.ts"
  sed -i 's/Merge conflict on \${branch}/Merge conflict on ${mergeRef}/g' "$GOALS_DIR/scheduler-prompt.ts"
  echo "[2/7] Merge conflict variable name fixed (mergeRef)"
else
  echo "[2/7] Merge conflict variable OK (uses 'branch')"
fi

# ─── Fix 3: scheduler-prompt.ts — add dist/ copy + prisma generate before tsc ───
# Check if fix already applied
if ! grep -q "Copy built dist/" "$GOALS_DIR/scheduler-prompt.ts"; then
  # Insert before the tsc line
  sed -i '/npx tsc --noEmit --project apps\/api\/tsconfig.json/i\
  // Copy built dist/ from main repo \xe2\x80\x94 worktree packages are gitignored, no dist/\
  try {\
    const mainPackagesDir = path.join(repoDir, '"'"'packages'"'"');\
    const wtPackagesDir = path.join(worktree, '"'"'packages'"'"');\
    if (fs.existsSync(mainPackagesDir) && fs.existsSync(wtPackagesDir)) {\
      for (const pkg of fs.readdirSync(mainPackagesDir)) {\
        const mainDist = path.join(mainPackagesDir, pkg, '"'"'dist'"'"');\
        const wtDist = path.join(wtPackagesDir, pkg, '"'"'dist'"'"');\
        if (fs.existsSync(mainDist) && !fs.existsSync(wtDist)) {\
          execSync(`cp -r "${mainDist}" "${wtDist}"`, { timeout: 10_000 });\
        }\
      }\
    }\
    const mainHarnessDist = path.join(repoDir, '"'"'..'"'"', '"'"'harness'"'"', '"'"'dist'"'"');\
    const wtHarnessDist = path.join(worktree, '"'"'harness'"'"', '"'"'dist'"'"');\
    if (fs.existsSync(mainHarnessDist) && !fs.existsSync(wtHarnessDist)) {\
      execSync(`cp -r "${mainHarnessDist}" "${wtHarnessDist}"`, { timeout: 10_000 });\
    }\
  } catch (e) {\
    logger.warn('"'"'[GoalScheduler] Failed to copy workspace dist/'"'"', { error: String(e) });\
  }\
  // Generate Prisma client \xe2\x80\x94 pnpm store may have stale types\
  try {\
    execSync('"'"'npx prisma generate 2>&1'"'"', { cwd: path.join(worktree, '"'"'packages'"'"', '"'"'studio-prisma'"'"'), timeout: 30_000 });\
  } catch (e) {\
    logger.warn('"'"'[GoalScheduler] prisma generate failed'"'"', { error: String(e) });\
  }' "$GOALS_DIR/scheduler-prompt.ts"
  echo "[3/7] dist/ copy + prisma generate added before tsc"
else
  echo "[3/7] dist/ copy already present"
fi

# ─── Fix 4: scheduler-prompt.ts — headCommit fallback in branch lookup ───
if ! grep -q "headCommit" "$GOALS_DIR/scheduler-prompt.ts"; then
  # After "if (!branchExists)" block, add headCommit fallback before "missingBranches.push"
  sed -i '/if (!branchExists) {/,/missingBranches.push/{
    /missingBranches.push/i\
    // Fallback: use stored headCommit from execution output\
    if (!refExists) {\
      try {\
        const output = typeof exec.output === '"'"'string'"'"' ? JSON.parse(exec.output) : (exec.output || {});\
        const sha = output?.headCommit;\
        if (sha) {\
          execSync(`git cat-file -t "${sha}"`, { cwd: worktree, timeout: 5_000, stdio: '"'"'pipe'"'"' });\
          mergeRef = sha;\
          refExists = true;\
          logger.info('"'"'[GoalScheduler] Using stored headCommit for merge'"'"', { executionId: exec.id, sha });\
        }\
      } catch { /* SHA not available or not valid */ }\
    }
  }' "$GOALS_DIR/scheduler-prompt.ts"
  echo "[4/7] headCommit fallback added"
else
  echo "[4/7] headCommit fallback already present"
fi

# ─── Fix 5: scheduler-integration.ts — disable abandonOrphanedRunning ───
sed -i 's/this\.abandonOrphanedRunning()\.catch/\/\/ abandonOrphanedRunning disabled — recoverStaleExecutions handles stale executions\n    \/\/ this.abandonOrphanedRunning().catch/' \
  "$GOALS_DIR/scheduler-integration.ts"
echo "[5/7] abandonOrphanedRunning disabled"

# ─── Fix 6: goal-lifecycle.ts — only cleanup on success ───
sed -i '/Cleanup executor worktrees/,/cleanupGoalWorktrees(goalId)/{
  /cleanupGoalWorktrees(goalId)/i\
  if (newStatus === '"'"'succeeded'"'"') {
  /cleanupGoalWorktrees(goalId)/a\
  }
}' "$GOALS_DIR/goal-lifecycle.ts"
echo "[6/7] Cleanup guard added (only on success)"

# ─── Fix 7: scheduler-dispatch.ts — store headCommit in execution output ───
if ! grep -q "headCommit" "$GOALS_DIR/scheduler-dispatch.ts"; then
  # After "const execOutput" line, add headCommit capture
  sed -i '/const execOutput = .*result.*output/,/await goalService.updateStepExecution/{
    /await goalService.updateStepExecution/i\
    let headCommit: string | undefined;\
    try {\
      const { execSync: execSyncLocal } = await import('"'"'child_process'"'"');\
      headCommit = execSyncLocal('"'"'git rev-parse HEAD'"'"', { cwd: worktreeDir, encoding: '"'"'utf-8'"'"', timeout: 5_000, stdio: '"'"'pipe'"'"' }).trim();\
    } catch { /* worktree may be cleaned up */ }\
    const outputData: Record<string, unknown> = {};\
    if (execOutput) {\
      try { Object.assign(outputData, JSON.parse(execOutput)); } catch { outputData.raw = execOutput; }\
    }\
    if (headCommit) outputData.headCommit = headCommit;
  }' "$GOALS_DIR/scheduler-dispatch.ts"
  echo "[7/7] headCommit storage added"
else
  echo "[7/7] headCommit storage already present"
fi

echo ""
echo "=== All fixes applied ==="
echo "Run 'bash fix-pipeline.sh' to re-apply if files get reverted."
