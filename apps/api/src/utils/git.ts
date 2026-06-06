/**
 * Git utilities — branch detection, worktree helpers
 */
import { execSync } from 'child_process';

/**
 * 检测仓库默认分支名（不猜 main/master）
 *
 * 优先级：
 * 1. git symbolic-ref refs/remotes/origin/HEAD → 远程默认分支
 * 2. 本地存在 main → main
 * 3. 本地存在 master → master
 * 4. fallback master
 */
export function getDefaultBranch(cwd: string): string {
  try {
    const remoteHead = execSync('git symbolic-ref refs/remotes/origin/HEAD', {
      cwd, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    // refs/remotes/origin/main → main
    return remoteHead.replace('refs/remotes/origin/', '');
  } catch { /* no remote HEAD */ }

  for (const branch of ['main', 'master']) {
    try {
      execSync(`git rev-parse --verify ${branch}`, {
        cwd, timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
      });
      return branch;
    } catch { /* branch doesn't exist */ }
  }

  return 'master';
}
