/**
 * Agent Runner — unified executor
 *
 * 特性：
 *   - Uses `--output-format stream-json` (line-by-line JSON events)
 *   - Parses stdout for tool_use blocks, emits tool:call + file:change StudioEvents
 *   - Workspace fallback: task.parameters.workspaceRoot → DB query → createWorktree()
 *   - Stuck detection with strategy hints injection
 *
 * 模块拆分：实现按职责拆到
 *   - runner-params.ts      参数构建（prompt / session flag / cmd / env / 前置检查）
 *   - runner-output.ts      输出解析（mtime 探测 / RKB 已知解法）
 *   - runner-execution.ts   执行（多 session 循环）
 *   - runner-lightweight.ts 执行（轻量单 session）
 *   - types.ts              公共类型（ExecutorConfig / AgentTask / ExecutionResult / PrerequisiteCheck）
 * 本文件保留门面类与全部公共 API（含函数 re-export），调用方零改动。
 *
 * 2026-08: 旧 AgentExecutor 双胞胎（session-manager.ts）已删除，本类是唯一执行器，
 * stop() 所有权统一在此（runningProcesses map 只在本类注册）。
 */

import type { ChildProcess } from 'child_process';
import * as path from 'path';
import * as fsSync from 'fs';
import * as os from 'os';
import { logger, type StreamEvent } from '@dommaker/studio-shared';

import { executeSessionLoop } from './runner-execution.js';
import { executeLightweightSession } from './runner-lightweight.js';

// ─── 公共类型（原 session-manager.ts，现 types.ts） ───

export type { ExecutorConfig, AgentTask, ExecutionResult, PrerequisiteCheck } from './types.js';

import type { ExecutorConfig, AgentTask, ExecutionResult } from './types.js';

// ─── Stream-json output event ───

/** @deprecated Use StreamEvent from @dommaker/studio-shared */
export type OutputEvent = StreamEvent;

// ─── Function re-exports (保持原 agent-runner.js 导入路径兼容) ───

export { buildAugmentedPrompt } from './runner-params.js';
export { hasRecentActivity } from './runner-output.js';

const DEFAULT_MAX_SESSIONS = 5;

// ─── AgentRunner class ───

export class AgentRunner {
  private config: ExecutorConfig;
  private runningProcesses = new Map<string, { current: ChildProcess | null }>();

  constructor(config?: Partial<ExecutorConfig>) {
    const homeDir = os.homedir();
    this.config = {
      worktreesDir: config?.worktreesDir || process.env.WORKTREES_DIR || path.join(homeDir, 'worktrees'),
      repoDir: config?.repoDir || (() => {
        let dir = process.cwd();
        while (dir !== '/' && !fsSync.existsSync(path.join(dir, 'package.json'))) {
          dir = path.dirname(dir);
        }
        return fsSync.existsSync(path.join(dir, 'package.json')) ? dir : path.join(homeDir, 'projects');
      })(),
      taskTimeoutMinutes: config?.taskTimeoutMinutes || 60,
      sessionTimeoutMinutes: config?.sessionTimeoutMinutes || 30,
      maxSessions: config?.maxSessions || DEFAULT_MAX_SESSIONS,
      ...config,
    };
  }

  // ========================================
  // Execute (delegates to runner-execution / runner-lightweight)
  // ========================================

  async execute(task: AgentTask): Promise<ExecutionResult> {
    return executeSessionLoop({ config: this.config, runningProcesses: this.runningProcesses }, task);
  }

  async executeLightweight(task: AgentTask): Promise<ExecutionResult> {
    return executeLightweightSession({ config: this.config, runningProcesses: this.runningProcesses }, task);
  }

  // ========================================
  // Process control
  // ========================================

  async stop(executionId: string): Promise<void> {
    let childRef = this.runningProcesses.get(executionId);
    if (!childRef) {
      for (const [key, value] of this.runningProcesses.entries()) {
        if (key.startsWith(executionId)) {
          childRef = value;
          executionId = key;
          break;
        }
      }
    }

    if (childRef?.current) {
      logger.info('[AgentRunner] Stopping child process', { executionId });
      childRef.current.kill('SIGTERM');
      this.runningProcesses.delete(executionId);

      setTimeout(() => {
        if (childRef?.current) {
          logger.warn('[AgentRunner] SIGTERM grace period expired, force SIGKILL', { executionId });
          try { childRef.current.kill('SIGKILL'); } catch { logger.warn('[AgentRunner] SIGKILL failed', { executionId }); }
        }
      }, 5000);
    } else {
      logger.info('[AgentRunner] Stop requested but no child process found', { executionId });
    }
  }

  /**
   * #178（#63 决议 2/3）：杀 executionId 对应 CLI 的整进程组。
   * execSh killProcessGroup 以 detached  spawn，child.pid 即进程组组长；
   * #68 实测 SIGTERM 杀不死孙进程，必须 kill(-pid) 杀整组。ESRCH = 已死，跳过；
   * 组杀失败（非 ESRCH）回落单进程 SIGKILL。best-effort，绝不抛错。
   */
  async stopProcessGroup(executionId: string): Promise<void> {
    const childRef = this.runningProcesses.get(executionId);
    const child = childRef?.current;
    const pid = child?.pid;
    if (!child || pid === undefined) {
      logger.info('[AgentRunner] stopProcessGroup: no child process found', { executionId });
      return;
    }
    logger.info('[AgentRunner] Killing child process group', { executionId, pid });
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ESRCH') {
        try { child.kill('SIGKILL'); } catch { /* best-effort */ }
      }
    }
    this.runningProcesses.delete(executionId);
  }

  /**
   * #179（#66 决议 2）：优雅关闭杀全部在飞 CLI 进程组 —— 经 runningProcesses 注册表
   * 逐组 SIGTERM，不等 step 落盘（部署 5s 强制 exit 纪律不变，残留由强退兜底）；
   * 在飞 WU 回收交给 #63 租约。best-effort：ESRCH/空条目只清注册表不抛错。
   * @returns 实际 SIGTERM 到的进程组数
   */
  async stopAllProcessGroups(): Promise<number> {
    const entries = [...this.runningProcesses.entries()];
    let killed = 0;
    for (const [executionId, childRef] of entries) {
      const child = childRef.current;
      const pid = child?.pid;
      this.runningProcesses.delete(executionId);
      if (!child || pid === undefined) continue;
      logger.info('[AgentRunner] Shutdown: SIGTERM child process group', { executionId, pid });
      try {
        process.kill(-pid, 'SIGTERM');
        killed++;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ESRCH') {
          try { child.kill('SIGTERM'); killed++; } catch { /* best-effort */ }
        }
      }
    }
    return killed;
  }

  getStatus(): { config: ExecutorConfig } {
    return { config: this.config };
  }
}

export const agentRunner = new AgentRunner();
