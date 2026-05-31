// Studio Daemon — persistent Agent session manager
// B0-007: session-id file bridge for prompt cache reuse
import { SessionManager } from './session-manager.js';
import type { JobSpec, TaskResult } from './session-manager.js';
import { logger } from '@dommaker/studio-shared';
import { execSh } from '@dommaker/studio-shared/node';
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

    // Health probe: 确认 Claude CLI 能在当前环境下正常启动
    this.runHealthProbe();

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

  /** Ad-hoc session: create unique session, run job, cleanup. No isBusy guard. */
  async submitAdhocJob(job: JobSpec, options: { worktree: string; modelTier?: 'premium' | 'standard' | 'fast'; timeoutMs?: number }): Promise<TaskResult> {
    if (!this.started) throw new Error('Daemon not started');
    const name = `analyst-${Date.now()}-${Math.random().toString(36).slice(2, 4)}`;
    this.manager.registerAdhoc({
      name,
      worktree: options.worktree,
      modelTier: options.modelTier || 'premium',
      timeoutMs: options.timeoutMs || 30 * 60_000,
      persistent: false,
    });
    try {
      return await this.manager.runTask(name, job);
    } finally {
      this.manager.unregister(name);
    }
  }

  getStatus(sessionName?: string) {
    if (sessionName) return this.manager.getStatus(sessionName);
    return this.manager.getAllStatus();
  }

  /** 启动健康探测：确认 Claude CLI 能在当前环境正常启动 */
  private runHealthProbe(): void {
    const cmd = 'IS_SANDBOX=1 claude --print --output-format json -p "ok" 2>&1';
    execSh(cmd, { cwd: REPO_DIR, timeoutMs: 30_000, maxBuffer: 1024 * 1024 })
      .then(() => logger.info('[StudioDaemon] Health probe passed'))
      .catch((e: any) => {
        logger.error('[StudioDaemon] Health probe FAILED — Claude CLI may be broken', {
          error: (e?.message || String(e)).slice(0, 200),
          hint: 'Check IS_SANDBOX, STUDIO_API_KEY, claude binary path',
        });
      });
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
