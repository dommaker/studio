// AgentLoop 进程/git 小工具 —— 从 agent-loop.ts 原样抽出，行为不变。
import { existsSync } from 'fs';
import { join } from 'path';
import * as os from 'os';

/** Check if a process is alive by sending signal 0 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** B3b-i: 判断路径是否 git 仓库根（.git 存在即可，与 createWorktree 校验口径一致） */
export function isGitRepoRoot(root: string): boolean {
  try {
    return existsSync(join(root, '.git'));
  } catch {
    return false;
  }
}

/** B3b-i: worktrees 根目录解析（与 AgentRunner config 口径一致：WORKTREES_DIR > ~/worktrees） */
export function resolveWorktreesDir(): string {
  return process.env.WORKTREES_DIR || join(os.homedir(), 'worktrees');
}
