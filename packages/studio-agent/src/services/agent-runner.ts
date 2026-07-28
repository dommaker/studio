/**
 * Agent Runner — unified executor merging AgentExecutor + TaskExecutor
 *
 * Key differences from AgentExecutor (session-manager.ts):
 *   - Uses `--output-format stream-json` (line-by-line JSON events)
 *   - Parses stdout for tool_use blocks, emits tool:call + file:change StudioEvents
 *   - Workspace fallback: task.parameters.workspaceRoot → DB query → createWorktree()
 *   - Stuck detection with strategy hints injection
 *
 * 模块拆分（零行为变更）：实现按职责拆到
 *   - runner-params.ts      参数构建（prompt / session flag / cmd / env / 前置检查 / SDD）
 *   - runner-output.ts      输出解析（mtime 探测 / RKB 已知解法）
 *   - runner-execution.ts   执行（多 session 循环）
 *   - runner-lightweight.ts 执行（轻量单 session）
 * 本文件保留门面类与全部公共 API（含函数 re-export），调用方零改动。
 */

import type { ChildProcess } from 'child_process';
import * as path from 'path';
import * as fsSync from 'fs';
import * as os from 'os';
import { logger, parseStreamEvents, extractResult, type StreamEvent } from '@dommaker/studio-shared';

import { resolveWorkspace } from './worktree-resolver.js';
import { checkPrerequisites, buildPrompt, resolveSddTaskData } from './runner-params.js';
import { executeSessionLoop } from './runner-execution.js';
import { executeLightweightSession } from './runner-lightweight.js';

import type { ProgressReport } from './output-capture.js';

// ─── Re-use types from session-manager ───

export type { ExecutorConfig, AgentTask, ExecutionResult, PrerequisiteCheck } from './session-manager.js';

import type { ExecutorConfig, AgentTask, ExecutionResult, PrerequisiteCheck } from './session-manager.js';

// ─── Stream-json output event ───

/** @deprecated Use StreamEvent from @dommaker/studio-shared */
export type OutputEvent = StreamEvent;

// ─── Function re-exports (保持原 agent-runner.js 导入路径兼容) ───

export { buildAugmentedPrompt } from './runner-params.js';
export { hasRecentActivity } from './runner-output.js';

const DEFAULT_MAX_SESSIONS = 5;

// ─── Interface ───

export interface IAgentRunner {
  execute(task: AgentTask): Promise<ExecutionResult>;
}

// ─── AgentRunner class ───

export class AgentRunner implements IAgentRunner {
  private config: ExecutorConfig;
  private runningProcesses = new Map<string, { current: ChildProcess | null }>();

  constructor(config?: Partial<ExecutorConfig>) {
    const homeDir = os.homedir();
    this.config = {
      worktreesDir: config?.worktreesDir || process.env.WORKTREES_DIR || path.join(homeDir, 'worktrees'),
      repoDir: config?.repoDir || process.env.REPO_DIR || (() => {
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
  // Workspace resolution (AC1.2)
  // ========================================

  /**
   * 3-priority workspace fallback (delegates to shared resolveWorkspace):
   *   1. task.parameters.workspaceRoot (direct)
   *   2. VPS workspace DB query (prisma.workspace.findFirst)
   *   3. createWorktree() fallback
   */
  async resolveWorktree(task: AgentTask): Promise<string> {
    return resolveWorkspace({
      task,
      worktreesDir: this.config.worktreesDir,
      repoDir: this.config.repoDir,
    });
  }

  // ========================================
  // Stream-json parsing (AC1.1 + AC1.3)
  // ========================================

  /**
   * Parse stream-json stdout into structured events.
   * Delegates to shared parseStreamEvents from @dommaker/studio-shared.
   */
  parseStreamOutput(stdout: string): StreamEvent[] {
    return parseStreamEvents(stdout);
  }

  /**
   * Extract the final text result from stream-json events.
   * Delegates to shared extractResult from @dommaker/studio-shared.
   */
  extractResult(events: StreamEvent[]): { text: string; isError: boolean } {
    return extractResult(events);
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
  // Delegates (保持原有方法签名)
  // ========================================

  /** SP-004 Step 5: SDD task layer resolution — see runner-params.ts */
  private async resolveSddTaskData(task: AgentTask): Promise<{
    contractTests: Array<{ file: string; content: string }> | undefined;
    testFiles: string[];
  }> {
    return resolveSddTaskData(task);
  }

  async checkPrerequisites(provider: string = 'claude'): Promise<PrerequisiteCheck[]> {
    return checkPrerequisites(this.config, provider);
  }

  buildPrompt(
    task: AgentTask,
    progress: ProgressReport | null,
    session: number,
    acGroup?: Record<string, any>,
    stuckCount = 0,
    knowledgeContext?: string,
    resolutionHint?: string,
    role: 'analyst' | 'executor' | 'reviewer' | 'integration' | 'deploy' = 'executor',
  ): string {
    return buildPrompt(task, progress, session, acGroup, stuckCount, knowledgeContext, resolutionHint, role);
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

  getStatus(): { config: ExecutorConfig } {
    return { config: this.config };
  }
}

export const agentRunner = new AgentRunner();
