/**
 * Claim Loop — AS-020 P5-02: Per-Runtime task polling
 *
 * 【未接线】daemon 客户端三件套之一（claim-loop + cli-adapter + task-executor）：
 * 服务端 6 个 /api/v1/daemon/tasks/* 端点已挂载并在等这个客户端，但
 * `studio daemon start` 目前只注册 workspace 不启动轮询。接入点：cli/admin.ts
 * studioDaemonStart()，约 40 行。接入前提：拍板 HTTP 轮询 vs WS agent-task vs
 * studio-agent AgentRunner 的路线，以及 daemon 长驻进程形态；注意 claim 整文件
 * 读改写的多 daemon 并发竞态。勿按死代码清理（2026-08-04 复审决议）。
 *
 * Each runtime gets an independent poll loop (3s interval).
 * Max 10 concurrent tasks per daemon.
 * Server sends 200 { task } or 204 (no task).
 */

import { logger } from '@dommaker/studio-shared';
import type { WorkspaceConfig } from './workspace-config.js';

export interface ClaimedTask {
  id: string;
  workspaceId: string;
  runtimeId: string | null;
  path: string;
  prompt: string;
  agent: string;
  sessionId: string | null;
  status: string;
  createdAt: string;
}

export interface ClaimLoopConfig {
  /** Server URL (from workspace config) */
  serverUrl: string;
  /** Auth token */
  token: string;
  /** Workspace ID (from registration) */
  workspaceId: string;
  /** Poll interval in ms (default 3000) */
  pollIntervalMs?: number;
  /** Max concurrent tasks (default 10) */
  maxConcurrent?: number;
}

export type TaskHandler = (task: ClaimedTask) => Promise<void>;

const DEFAULT_POLL_INTERVAL = 3_000;
const DEFAULT_MAX_CONCURRENT = 10;

export class ClaimLoop {
  private loops = new Map<string, { timer: ReturnType<typeof setTimeout>; running: boolean }>();
  private activeTasks = 0;
  private config: ClaimLoopConfig;
  private taskHandler: TaskHandler;
  private pollIntervalMs: number;
  private maxConcurrent: number;

  constructor(config: ClaimLoopConfig, handler: TaskHandler) {
    this.config = config;
    this.taskHandler = handler;
    this.pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL;
    this.maxConcurrent = config.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  }

  /**
   * Start claim loop for a runtime.
   */
  start(runtimeId: string): void {
    if (this.loops.has(runtimeId)) {
      logger.warn('[ClaimLoop] Already running', { runtimeId });
      return;
    }

    const state = { timer: null as ReturnType<typeof setTimeout> | null, running: true };
    this.loops.set(runtimeId, state);

    logger.info('[ClaimLoop] Started', { runtimeId, pollIntervalMs: this.pollIntervalMs });
    this.scheduleNext(runtimeId);
  }

  /**
   * Stop claim loop for a runtime.
   */
  stop(runtimeId: string): void {
    const state = this.loops.get(runtimeId);
    if (!state) return;

    state.running = false;
    if (state.timer) clearTimeout(state.timer);
    this.loops.delete(runtimeId);
    logger.info('[ClaimLoop] Stopped', { runtimeId });
  }

  /**
   * Stop all loops.
   */
  stopAll(): void {
    for (const runtimeId of this.loops.keys()) {
      this.stop(runtimeId);
    }
  }

  /**
   * Trigger immediate poll for a runtime (wakeup hint).
   */
  wakeup(runtimeId: string): void {
    const state = this.loops.get(runtimeId);
    if (!state || !state.running) return;

    if (state.timer) clearTimeout(state.timer);
    this.poll(runtimeId);
  }

  /**
   * Number of currently active (running) tasks.
   */
  getActiveCount(): number {
    return this.activeTasks;
  }

  /**
   * List of runtime IDs with active loops.
   */
  getActiveRuntimes(): string[] {
    return [...this.loops.keys()];
  }

  private scheduleNext(runtimeId: string): void {
    const state = this.loops.get(runtimeId);
    if (!state || !state.running) return;

    state.timer = setTimeout(() => this.poll(runtimeId), this.pollIntervalMs);
  }

  private async poll(runtimeId: string): Promise<void> {
    const state = this.loops.get(runtimeId);
    if (!state || !state.running) return;

    // Check capacity
    if (this.activeTasks >= this.maxConcurrent) {
      logger.debug('[ClaimLoop] At capacity, skipping', {
        runtimeId,
        active: this.activeTasks,
        max: this.maxConcurrent,
      });
      this.scheduleNext(runtimeId);
      return;
    }

    try {
      const task = await this.claimTask(runtimeId);
      if (task) {
        this.activeTasks++;
        logger.info('[ClaimLoop] Task claimed', {
          runtimeId,
          taskId: task.id,
          active: this.activeTasks,
        });

        // Fire-and-forget: handler runs asynchronously
        this.taskHandler(task)
          .catch(err => {
            logger.error('[ClaimLoop] Task handler error', {
              taskId: task.id,
              error: String(err),
            });
          })
          .finally(() => {
            this.activeTasks--;
          });
      }
    } catch (err) {
      logger.error('[ClaimLoop] Poll error', { runtimeId, error: String(err) });
    }

    this.scheduleNext(runtimeId);
  }

  private async claimTask(runtimeId: string): Promise<ClaimedTask | null> {
    const url = `${this.config.serverUrl.replace(/\/$/, '')}/api/v1/daemon/tasks/claim`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.token}`,
      },
      body: JSON.stringify({ runtime_id: runtimeId }),
    });

    if (response.status === 204) {
      return null;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Claim failed (${response.status}): ${text.slice(0, 200)}`);
    }

    const data = await response.json() as { task: ClaimedTask };
    return data.task;
  }
}
