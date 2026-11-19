import path from 'node:path';
import { createHash } from 'node:crypto';
import { type FileStore } from '@dommaker/studio-shared';
import { studioPath } from '@dommaker/studio-shared/studio-dir';
import { execFileAsync } from './exec-async.js';

const DEFAULT_LEG_LOCK_TIMEOUT_MS = 10 * 60_000;
const LEG_LOCK_HEARTBEAT_MS = 10_000;

export interface DeliveryLegLockOptions {
  fileStore: FileStore;
  repo: string;
  branch: string;
  timeoutMs?: number;
}

/**
 * 同一真实 Git common-dir + 交付分支的跨进程互斥锁。
 * capability/fd 路径不参与身份；锁文件是可再生产物，进程死亡由 FileStore stale 回收。
 */
export async function withDeliveryLegLock<T>(
  options: DeliveryLegLockOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const { fileStore, repo, branch, timeoutMs = DEFAULT_LEG_LOCK_TIMEOUT_MS } = options;
  const stdout = await execFileAsync('git', ['-C', repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: repo,
    timeout: 15_000,
  });
  const commonDir = stdout.trim();
  if (!commonDir) throw new Error(`无法解析 git common dir：${repo}`);
  const key = createHash('sha256').update(`${commonDir}\0${branch}`).digest('hex');
  const worktreesDir = process.env.WORKTREES_DIR || studioPath('worktrees');
  const lockDir = path.join(worktreesDir, '.delivery-locks', `${key}.lock`);
  return fileStore.withLock(lockDir, fn, timeoutMs, {
    heartbeatIntervalMs: LEG_LOCK_HEARTBEAT_MS,
    mutexTimeoutMs: timeoutMs,
  });
}
