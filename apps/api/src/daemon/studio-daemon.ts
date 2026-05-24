// Studio Daemon — persistent Agent session manager
// B0-007: session-id file bridge for prompt cache reuse
import { SessionManager } from './session-manager.js';
import type { JobSpec, TaskResult } from './session-manager.js';
import { logger } from '@dommaker/studio-shared';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import * as fs from 'fs';

const WORKTREES_DIR = process.env.WORKTREES_DIR || path.join(os.homedir(), 'worktrees');
const REPO_DIR = process.env.REPO_DIR || process.cwd();

class StudioDaemon {
  private manager = new SessionManager();
  private started = false;

  start(): void {
    if (this.started) return;

    // Analyst: 在项目根目录运行，能读代码库。worktree 存 .daemon/ 状态
    this.manager.register({
      name: 'analyst',
      worktree: REPO_DIR,
      modelTier: 'premium',
      timeoutMs: 30 * 60 * 1000, // 30 min
      persistent: true,
    });

    // Reviewer: 代码审查 worktree，复用 session cache
    const reviewWorktree = this.ensureReviewerWorktree();
    this.manager.register({
      name: 'reviewer',
      worktree: reviewWorktree,
      modelTier: 'standard',
      timeoutMs: 15 * 60 * 1000, // 15 min
      persistent: true,
    });

    this.started = true;
    logger.info('[StudioDaemon] Started', {
      sessions: this.manager.getAllStatus().map(s => s?.name),
    });
  }

  /** 为 Reviewer 创建审查 worktree */
  private ensureReviewerWorktree(): string {
    const wtPath = path.join(WORKTREES_DIR, 'reviewer-main');
    fs.mkdirSync(WORKTREES_DIR, { recursive: true });

    if (fs.existsSync(path.join(wtPath, '.git'))) {
      logger.info('[StudioDaemon] Reusing reviewer worktree', { path: wtPath });
      return wtPath;
    }

    try { fs.rmSync(wtPath, { recursive: true, force: true }); } catch {}
    try { execSync(`git worktree remove --force "${wtPath}" 2>/dev/null || true`, { cwd: REPO_DIR }); } catch {}

    try {
      const branchName = `daemon/reviewer-${Date.now().toString(36)}`;
      execSync(`git worktree add -b "${branchName}" "${wtPath}" HEAD`, {
        cwd: REPO_DIR, stdio: 'pipe', timeout: 30_000,
      });
      logger.info('[StudioDaemon] Created reviewer worktree', { path: wtPath, branch: branchName });
    } catch (err) {
      logger.warn('[StudioDaemon] Reviewer worktree failed, using plain directory', { error: String(err) });
      fs.mkdirSync(wtPath, { recursive: true });
      for (const f of ['package.json', 'tsconfig.json']) {
        const src = path.join(REPO_DIR, f);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(wtPath, f));
      }
    }

    return wtPath;
  }

  stop(): void {
    this.started = false;
    logger.info('[StudioDaemon] Stopped');
  }

  async submitJob(sessionName: string, job: JobSpec): Promise<TaskResult> {
    if (!this.started) throw new Error('Daemon not started');
    return this.manager.runTask(sessionName, job);
  }

  getStatus(sessionName?: string) {
    if (sessionName) return this.manager.getStatus(sessionName);
    return this.manager.getAllStatus();
  }

  /** Graceful shutdown — wait for running daemon tasks, then stop accepting new ones */
  async gracefulShutdown(): Promise<void> {
    this.started = false; // stop accepting new jobs
    await this.manager.shutdown(60_000); // wait up to 60s for running tasks
  }

  isStarted(): boolean {
    return this.started;
  }
}

export const daemon = new StudioDaemon();
export type { JobSpec, TaskResult };
