// Studio Daemon — persistent Agent session manager
// B0-007: session-id file bridge for prompt cache reuse
//
// B4a（决策 D8）：reviewer session 已摘除 —— 旧实现每次 start() 为 reviewer
// 建专属 worktree（分支 daemon/reviewer-*，从不合从不删，泄漏源头），
// 且 submitJob/submitAdhocJob 全库无生产调用方。评审职能由 B4a 内置
// reviewer AgentProfile + ReviewDispatcher 接管。index.ts 已不再调 start()。
import { SessionManager } from './session-manager.js';
import type { JobSpec, TaskResult } from './session-manager.js';
import { logger } from '@dommaker/studio-shared';
import { execSh, buildHealthProbeCommand } from '@dommaker/studio-shared/node';

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
      timeoutMs: 30 * 60 * 1000, // 30 min
      persistent: true,
    });

    this.started = true;
    logger.info('[StudioDaemon] Started', {
      sessions: this.manager.getAllStatus().map(s => s?.name),
    });
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
  async submitAdhocJob(job: JobSpec, options: { worktree: string; timeoutMs?: number }): Promise<TaskResult> {
    if (!this.started) throw new Error('Daemon not started');
    const name = `analyst-${Date.now()}-${Math.random().toString(36).slice(2, 4)}`;
    this.manager.registerAdhoc({
      name,
      worktree: options.worktree,
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

  /**
   * 启动健康探测：确认 Claude CLI 二进制可用（不调 LLM）。
   *
   * 只跑 `claude --version`，复用 buildHealthProbeCommand 与
   * agent-loop / session-manager 保持一致。禁止用 `claude --print -p ...`
   * 之类会触发 LLM 调用的命令做 health probe。
   */
  private runHealthProbe(): void {
    const cmd = buildHealthProbeCommand('claude');
    execSh(cmd, { cwd: REPO_DIR, timeoutMs: 10_000, maxBuffer: 1024 * 1024 })
      .then(() => logger.info('[StudioDaemon] Health probe passed', { cmd }))
      .catch((e: any) => {
        logger.error('[StudioDaemon] Health probe FAILED - Claude CLI may be broken', {
          cmd,
          error: (e?.message || String(e)).slice(0, 200),
          hint: 'Check claude binary path',
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
