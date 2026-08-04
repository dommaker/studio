/**
 * Session Manager — Agent 执行器核心（session loop + async spawn）
 *
 * P11-02: Extracted from agent-executor.ts
 *
 * 2026-08-04: 按职责再拆分（零行为变更）：
 *   prompt-builder.ts — prompt 构建（Session 1 全量 / Session 2+ 续接 / STRATEGY_HINTS）
 *   prerequisite-checks.ts — 前置检查（CLI 探测 / 磁盘 / 目录 / git repo）+ PrerequisiteCheck 类型
 *
 * 2026-05-09: Docker+tmux → async spawn (复用 SessionManager 的 execSh 模式)
 *   - 每个 GoalExecution 独立 worktree → 天然支持并行
 *   - Session 1: --session-id <UUID> --name <name>  创建命名 session
 *   - Session 2+: --continue  复用 prompt cache
 *   - 读 .progress.json 判断完成，不信任 exit code
 */

import type { ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import { logger, parseStreamEvents, extractResult, extractToolCalls, extractFilePath, FileStore } from '@dommaker/studio-shared';
import { execSh, resolveSessionId, readSessionIdFile, resolveProviderDefinition, type ProviderId } from '@dommaker/studio-shared/node';
import { beforeAgentExecute } from '@dommaker/studio-shared/harness/hooks';
import { buildSpawnArgs } from '../cli-adapter.js';

import {
  createWorktree,
  resolveWorkspace,
  propagateHarnessConfig,
  buildCachePrefix,
  writeRequirementsMd,
  writeContractTests,
  ensureDeps,
} from './worktree-resolver.js';
import {
  readProgress,
  collectOutputFiles,
  recordSessionMetrics,
  emitSessionStart,
  emitSessionEnd,
  recordExecutionError,
  getConstraintMeta,
  type ProgressReport,
} from './output-capture.js';
import { buildPrompt } from './prompt-builder.js';
import { checkPrerequisites, type PrerequisiteCheck } from './prerequisite-checks.js';

// ─── 配置类型 ───

export interface ExecutorConfig {
  worktreesDir: string;
  repoDir: string;
  taskTimeoutMinutes: number;
  sessionTimeoutMinutes: number;
  maxSessions: number;
}

// ─── 任务类型 ───

export interface AgentTask {
  id: string;
  executionId: string;
  provider: ProviderId;
  prompt: string;
  notifyTarget?: string;
  parameters?: {
    sessionId?: string;
    /** true = sessionId 指向已存在会话（续用），cli-adapter 按 provider 换 resume 语法（claude --resume） */
    sessionResume?: boolean;
    maxTurns?: number;
    knowledgeContext?: string;
    agentRole?: string;
    [key: string]: unknown;
  };
  /** 实时进度回调 — 每轮 session 后调用，用于推送到 Channel */
  onProgress?: (progress: ProgressReport, session: number) => Promise<void>;
  /**
   * 步内 stream-json 行回调（WU 过程可视化 Layer B）：CLI stdout 每个完整行到达即回调。
   * 仅本地同进程执行有意义（远程节点方向已放弃，2026-08 删除 RemoteExecutor）。
   */
  onStreamLine?: (line: string) => void;
  /** P3: 覆盖扁平默认超时 (ms)。提供时替代默认 30min。 */
  timeoutMs?: number;
  /** @deprecated §9.6 远程节点方向已放弃（2026-08）：字段仅为数据兼容保留，执行面恒为 LocalExecutor。 */
  nodeId?: string;
}

// ─── 执行结果 ───

export interface ExecutionResult {
  success: boolean;
  worktree: string;
  outputFiles: string[];
  error?: string;
  failureLog?: string; // 完整失败上下文（stdout+stderr），用于根因诊断
  logFile: string;
  sessionCount: number;
  totalDurationMs?: number;
  sessionIds?: string[]; // B9-014: collected session IDs for summary generation
  /** P9: 原始 stdout 文本（lightweight 模式产出，供调用方解析） */
  outputText?: string;
  /**
   * R2: 原始 stream-json stdout（lightweight 模式产出）。outputText 是
   * extractResult 后的纯文本（不含 stream-json 事件行），调用方需要解析
   * tool_use/usage 事件时必须使用本字段（如 agent-loop 的 tool:call 落盘）。
   */
  rawOutput?: string;
  /**
   * M2: CLI 回报的执行 token 用量（stream-json usage 聚合，extractUsage 产出）。
   * CLI 未回报 usage 时缺省 —— 调用方据此标记 executionSource='unavailable'，不编造 0。
   */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    model: string;
  };
}

// ─── 前置检查结果 ───

// PrerequisiteCheck 移至 prerequisite-checks.ts；re-export 保持导出面不变
export type { PrerequisiteCheck } from './prerequisite-checks.js';

const DEFAULT_SESSION_TIMEOUT = 30; // 分钟
const DEFAULT_MAX_SESSIONS = 5;
const STUDIO_EVENTS_JSONL = path.join(os.homedir(), '.studio', 'logs', 'studio-events.jsonl');
const fileStore = new FileStore();

/**
 * Agent 执行器（session loop + async spawn）
 */
export class AgentExecutor {
  private config: ExecutorConfig;
  private runningProcesses = new Map<string, { current: ChildProcess | null }>();

  constructor(config?: Partial<ExecutorConfig>) {
    const homeDir = os.homedir();

    this.config = {
      worktreesDir: config?.worktreesDir || process.env.WORKTREES_DIR || path.join(homeDir, 'worktrees'),
      repoDir: config?.repoDir || process.env.REPO_DIR || (() => {
        // 默认回退：向上找 package.json
        let dir = process.cwd();
        while (dir !== '/' && !fsSync.existsSync(path.join(dir, 'package.json'))) {
          dir = path.dirname(dir);
        }
        return fsSync.existsSync(path.join(dir, 'package.json')) ? dir : path.join(homeDir, 'projects');
      })(),
      taskTimeoutMinutes: config?.taskTimeoutMinutes || 60,
      sessionTimeoutMinutes: config?.sessionTimeoutMinutes || DEFAULT_SESSION_TIMEOUT,
      maxSessions: config?.maxSessions || DEFAULT_MAX_SESSIONS,
      ...config,
    };
  }

  /**
   * 执行任务（session loop 模型）
   *
   * 不信任 Claude Code exit code，改读 .progress.json 判断完成。
   * 静默退出 / 超时 / 崩溃 → 自动 re-spawn。
   */
  async execute(task: AgentTask): Promise<ExecutionResult> {
    let worktree = path.join(this.config.worktreesDir, task.executionId);
    let logFile = path.join(worktree, '.agent.log');

    logger.info('[AgentExecutor] Starting session loop', { taskId: task.id, executionId: task.executionId });

    try {
      // Step 1: 前置检查
      const checks = await this.checkPrerequisites(task.provider || 'claude');
      const errors = checks.filter(c => !c.passed && !c.isWarning);
      if (errors.length > 0) {
        throw new Error(`前置检查失败: ${errors.map(e => e.message).join(', ')}`);
      }

      // Step 2: resolve workspace (DB query → worktree fallback)
      worktree = await resolveWorkspace({
        task,
        worktreesDir: this.config.worktreesDir,
        repoDir: this.config.repoDir,
      });
      logFile = path.join(worktree, '.agent.log');

      // Step 2.1: 传播 harness 约束 + Claude 权限配置
      await propagateHarnessConfig(worktree, task.id, task.executionId, this.config.repoDir);

      // Step 2.2: 预填充 node_modules（依赖缓存，避免每次 pnpm install）
      try {
        await ensureDeps(worktree, this.config.repoDir);
      } catch (e) {
        logger.warn('[AgentExecutor] ensureDeps failed (non-blocking, agent will install)', {
          taskId: task.id, executionId: task.executionId, error: String(e),
        });
      }

      // Write shared cache prefix file
      try {
        const prefixPath = path.join(worktree, 'CACHE_PREFIX.md');
        if (!fsSync.existsSync(prefixPath)) {
          const shared = buildCachePrefix(this.config.repoDir);
          fsSync.writeFileSync(prefixPath, shared, 'utf-8');
        }
      } catch { /* non-blocking */ }

      // Step 2.5: 前置硬约束检查 (Iron Laws)
      await beforeAgentExecute({
        operation: 'code_implementation',
        hasWorktree: true,
        worktreePath: worktree,
        taskDescription: task.prompt,
        hasVerificationEvidence: true,
        hasRequirement: true,
        hasSingleTask: true,
        hasRequirementReview: true,
        hasExternalCapabilityVerification: true,
        hasTest: true,
        hasTwoStageReview: true,
        hasRootCauseInvestigation: true,
        hasFailingTest: true,
      });

      // Step 2.6: 写入 REQUIREMENTS.md（文件桥，session 间不重复传）
      const acGroup = task.parameters?.acGroup as Record<string, any> | undefined;
      await writeRequirementsMd(worktree, task, acGroup);

      // TDD-07: 写入 Analyst 的契约测试
      const contractTests = task.parameters?.contractTests as Array<{ file: string; content: string }> | undefined;
      if (contractTests?.length) {
        await writeContractTests(worktree, contractTests);
      }

      // Step 3: Session loop（含卡住检测 + 策略切换）
      let sessionCount = 0;
      let stuckCount = 0;
      let lastStep = '';
      let lastCompletedCount = 0;
      let cumulativeSessionMs = 0;
      let resolutionHint = ''; // RKB: 从 Resolution DB 匹配的已知解法

      // Session-id：同 Goal 内所有 step 共享，避免每个 step 从零重建上下文
      const goalId = (task.parameters?.goalId as string) || task.executionId;
      // O2a: Share session-id per agent role for cross-goal cache
      const agentRole = (task.parameters?.agentRole as string) || 'executor';
      const sessionDir = path.join(this.config.worktreesDir, '.shared-sessions', agentRole);
      const sessionFile = path.join(sessionDir, 'session-id');
      // Keep per-goal session file as fallback
      const goalSessionDir = path.join(this.config.worktreesDir, '.goal-sessions', goalId.slice(0, 16));
      const goalSessionFile = path.join(goalSessionDir, 'session-id');
      let sessionId: string;
      let isNewSession: boolean;
      const collectedSessionIds: string[] = []; // B9-014: collect session IDs
      // Try shared session first, fall back to per-goal
      const sharedId = fsSync.existsSync(sessionFile) ? readSessionIdFile(worktree, { sessionIdFile: sessionFile }) : null;
      if (sharedId) {
        sessionId = sharedId;
        isNewSession = false;
      } else {
        const existingGoalId = readSessionIdFile(worktree, { sessionIdFile: goalSessionFile });
        if (existingGoalId) {
          sessionId = existingGoalId;
          isNewSession = false;
        } else {
          sessionId = resolveSessionId(worktree, { sessionIdFile: sessionFile });
          isNewSession = true;
        }
      }

      while (sessionCount < this.config.maxSessions) {
        sessionCount++;

        // 确保文件桥存在（可能被上轮 session 删除）
        const reqPath = path.join(worktree, 'REQUIREMENTS.md');
        if (!fsSync.existsSync(reqPath)) {
          fsSync.mkdirSync(worktree, { recursive: true });
          logger.warn('[AgentExecutor] REQUIREMENTS.md missing, re-writing', { taskId: task.id, executionId: task.executionId, session: sessionCount });
          await writeRequirementsMd(worktree, task, acGroup);
          // TDD-07: Re-write contract tests if REQUIREMENTS.md was deleted
          if (contractTests?.length) {
            await writeContractTests(worktree, contractTests);
          }
        }

        // 读进度（session 2+ 用于续接 prompt）
        const progress = readProgress(worktree);

        // FIX #1: 上一轮已标记完成 → 不再调度新 session
        if (sessionCount > 1 && progress?.allComplete && (progress.testResults?.failed === 0 || progress.testResults?.failed == null)) {
          const outputFiles = await collectOutputFiles(worktree);
          logger.info('[AgentExecutor] Task already complete from previous session, skipping', { taskId: task.id, executionId: task.executionId, sessionCount: sessionCount - 1 });
          return { success: true, worktree, outputFiles, logFile, sessionCount: sessionCount - 1, totalDurationMs: cumulativeSessionMs, sessionIds: collectedSessionIds };
        }

        // 实时进度回调 → Channel
        if (task.onProgress && progress) {
          task.onProgress(progress, sessionCount).catch(() => {});
        }

        // 卡住检测：连续 session 无进展
        const currentStep = progress?.currentStep || '';
        const completedCount = progress?.completedSteps?.length || 0;

        if (sessionCount > 1) {
          if (currentStep === lastStep && completedCount <= lastCompletedCount) {
            stuckCount++;
            logger.warn('[AgentExecutor] Stuck detected', { taskId: task.id, executionId: task.executionId, session: sessionCount, stuckCount, currentStep, completedCount });
          } else {
            stuckCount = Math.max(0, stuckCount - 1);
          }
        }
        lastStep = currentStep;
        lastCompletedCount = completedCount;

        // 构建 prompt（卡住时注入策略切换 + RKB 已知解法）
        const knowledgeContext = (task.parameters?.knowledgeContext as string) || '';
        const prompt = this.buildPrompt(task, progress, sessionCount, acGroup, stuckCount, knowledgeContext, resolutionHint);
        fsSync.mkdirSync(worktree, { recursive: true });
        await fs.writeFile(path.join(worktree, '.prompt.md'), prompt, 'utf-8');
        logger.info('[AgentExecutor] Prompt built', { taskId: task.id, executionId: task.executionId, session: sessionCount, promptSize: prompt.length, knowledgeContextSize: knowledgeContext.length });

        // 启动 Agent（async spawn）
        // F4: provider 定义来自共享 registry；session 续接 flags（--session-id/--continue/--name）
        // 是 claude 专属语法，其它 provider 的 session 由 spawn 模板处理（见 cli-adapter）。
        const provider = task.provider || 'claude';
        const providerDef = resolveProviderDefinition(provider);
        const isFirstSession = sessionCount === 1;
        const sessionFlag = provider === 'claude'
          ? (isFirstSession
              ? (isNewSession
                  ? `--session-id ${sessionId} --name "executor-${task.executionId.slice(0, 8)}"`
                  : '--continue')
              : '--continue')
          : '';

        // Write prompt to file, pipe via stdin (same pattern as SessionManager)
        const promptFile = path.join(worktree, '.daemon', 'prompt.md');
        fsSync.mkdirSync(path.dirname(promptFile), { recursive: true });
        fsSync.writeFileSync(promptFile, prompt, 'utf-8');

        // O1c: Restrict tool access to verified files (prevents exploration drift)
        const _analystCtx = (task.parameters?.analystContext as any) || null;
        const _restrictDirs = _analystCtx?.verifiedFiles as string[] | undefined;
        const addDirArgs = _restrictDirs?.length && providerDef.spawn.addDirFlag
          ? _restrictDirs.map((f: string) => {
              const dir = f.split('/').slice(0, -1).join('/');
              return `${providerDef.spawn.addDirFlag} "${dir}"`;
            }).join(' ')
          : '';

        // F4: binary + base args from the provider registry (byte-identical for claude)
        const spawnArgs = buildSpawnArgs(provider, { worktreeDir: worktree });
        // --verbose already ships in claude's registry template; literal kept for the legacy cmd shape
        const verboseArg = spawnArgs.args.includes('--verbose') ? '' : (provider === 'claude' ? `--verbose` : '');
        // F4: prompt delivery per provider template — flag/positional providers read the
        // prompt file via shell substitution; claude/codex use stdin redirect (inline below).
        const promptNonStdinArg = providerDef.spawn.promptFlag
          ? `${providerDef.spawn.promptFlag} "$(cat "${promptFile}")"`
          : `"$(cat "${promptFile}")"`;

        const cmd = [
          `cd "${worktree}"`,
          `&&`,
          spawnArgs.command,
          ...spawnArgs.args,
          verboseArg,
          addDirArgs,
          sessionFlag,
          providerDef.spawn.promptViaStdin ? `< "${promptFile}"` : promptNonStdinArg,
          `2>&1`,
        ].filter(Boolean).join(' ');

        logger.info('[AgentExecutor] Spawning session', {
          taskId: task.id,
          executionId: task.executionId,
          session: sessionCount,
          isFirstSession,
          isNewSession,
        });

        // Track child process for external stop()
        const childRef: { current: ChildProcess | null } = { current: null };
        this.runningProcesses.set(task.executionId, childRef);

        const sessionStart = Date.now();
        collectedSessionIds.push(sessionId);

        // B9-014: emit session:start event
        await emitSessionStart(sessionId, task.executionId, sessionCount);

        try {
          const { stdout } = await execSh(cmd, {
            cwd: worktree,
            env: {
              STUDIO_EXECUTION_ID: task.executionId,
              ...(task.parameters?.goalId ? { STUDIO_GOAL_ID: task.parameters.goalId as string } : {}),
              HOME: `/tmp/execution-${task.executionId}`,
            },
            timeoutMs: this.config.sessionTimeoutMinutes * 60 * 1000,
            maxBuffer: 10 * 1024 * 1024,
            childRef,
          });
          // OBS-3: Persist raw stdout to .agent.log (replaces shell pipe | tee)
          fsSync.writeFileSync(logFile, stdout, 'utf-8');

          // D4: Parse stream-json output (replaces JSON envelope)
          const events = parseStreamEvents(stdout);
          const { text: resultText, isError } = extractResult(events);
          let text = resultText;
          if (!text && !isError) {
            text = stdout;
          }

          if (isError) {
            logger.warn('[AgentExecutor] Claude Code returned error', { taskId: task.id, executionId: task.executionId, session: sessionCount, text: text.slice(0, 200) });
          }

          // D4: Emit tool:call and file:change events via JSONL
          // AS-021 #2: Include sessionId so session-summary-generator can correlate events
          const toolCalls = extractToolCalls(events);
          for (const tool of toolCalls) {
            try {
              await fileStore.appendJsonl(STUDIO_EVENTS_JSONL, {
                type: 'tool:call',
                source: 'agent-executor',
                executionId: task.executionId,
                payload: JSON.stringify({ tool: tool.name, input: tool.input, sessionId }),
                createdAt: new Date().toISOString(),
              });
              const filePath = extractFilePath(tool.name, tool.input);
              if (filePath) {
                await fileStore.appendJsonl(STUDIO_EVENTS_JSONL, {
                  type: 'file:change',
                  source: 'agent-executor',
                  executionId: task.executionId,
                  payload: JSON.stringify({ path: filePath, action: 'write', sessionId }),
                  createdAt: new Date().toISOString(),
                });
              }
            } catch { /* non-blocking */ }
          }

          // Record session metrics as StudioEvent (observability)
          const sessionMs = Date.now() - sessionStart;
          const { hash, size } = await getConstraintMeta();
          await recordSessionMetrics({
            stdout,
            executionId: task.executionId,
            agentRole: 'executor',
            stage: task.parameters?.stage as string,
            sessionCount,
            isFirstSession,
            sessionMs,
            promptSize: prompt.length,
            constraintHash: hash,
            constraintSize: size,
          });

          // B9-014: emit session:end event
          await emitSessionEnd(sessionId, task.executionId, sessionCount);
        } catch (execErr: any) {
          const errMsg = execErr instanceof Error ? execErr.message : String(execErr);
          const errStack = execErr instanceof Error ? execErr.stack?.slice(0, 2000) : undefined;
          // 2>&1 重定向 stderr→stdout，stderr 为空；实际错误信息在 stdout
          const stdoutText = execErr?.stdout?.toString().slice(0, 2000) || '';
          const stderrText = execErr?.stderr?.toString().slice(0, 500) || '';

          cumulativeSessionMs += Date.now() - sessionStart;
          // OBS-4: Store full error with stack trace in GoalExecution
          await recordExecutionError({
            executionId: task.executionId,
            errMsg,
            errStack,
            stderrText,
            stdoutText,
            sessionCount,
            cumulativeSessionMs,
            signal: execErr?.signal,
            code: execErr?.code,
          });

          logger.warn('[AgentExecutor] Session failed', {
            taskId: task.id, executionId: task.executionId,
            session: sessionCount, sessionMs: Date.now() - sessionStart,
            cumulativeSessionMs,
            error: errMsg.slice(0, 200),
            stdout: stdoutText.slice(0, 500),
          });

          // RKB: 查询已知解法 — 错误模式 → Resolution 映射
          try {
            const knowledgeDir = path.join(os.homedir(), '.studio', 'knowledge');
            const allKeys = await fileStore.listDocs(knowledgeDir);
            const resKeys = allKeys.filter((k: string) => k.startsWith('resolution-'));
            const resolutions: any[] = [];
            for (const key of resKeys) {
              const doc = await fileStore.readDoc(knowledgeDir, key);
              if (doc && (doc.meta.maturity === 'verified' || doc.meta.maturity === 'canonical')) {
                resolutions.push({
                  id: key.replace('resolution-', ''),
                  pattern: doc.meta.pattern || '',
                  title: doc.meta.title || '',
                  fix: (doc.body || '').replace(/^#.*\n/, '').replace(/^## Solution\n/, '').trim(),
                  verifyCount: doc.meta.verifyCount || 0,
                  status: doc.meta.maturity,
                });
              }
            }
            resolutions.sort((a: any, b: any) => (b.verifyCount || 0) - (a.verifyCount || 0));
            const matched: string[] = [];
            const lowerMsg = errMsg.toLowerCase();
            for (const r of resolutions) {
              try {
                if (new RegExp(r.pattern, 'i').test(errMsg)) {
                  matched.push(`- **${r.title}**: ${r.fix}`);
                }
              } catch {
                if (lowerMsg.includes(r.pattern.toLowerCase())) {
                  matched.push(`- **${r.title}**: ${r.fix}`);
                }
              }
            }
            if (matched.length > 0) {
              resolutionHint = '## 已知解法 (RKB)\n以下解法曾在类似错误上验证有效：\n' + matched.join('\n');
              logger.info('[AgentExecutor] Resolution matched', { taskId: task.id, executionId: task.executionId, matchedCount: matched.length });
            }
          } catch (rkbErr) { /* non-blocking */ }

          if (sessionCount >= this.config.maxSessions) {
            // stdout 包含 claude 实际输出（含错误详情），errMsg 可能因 2>&1 为空
            const detail = stdoutText ? stdoutText.slice(-500) : errMsg.slice(0, 200);
            return {
              success: false, worktree, outputFiles: [],
              error: `Max sessions (${this.config.maxSessions}) exhausted. Last error: ${detail}`,
              logFile, sessionCount,
            };
          }
          // 未达上限 → 继续下一轮
          continue;
        }

        // After first successful session, future starts use --continue
        isNewSession = false;
        cumulativeSessionMs += Date.now() - sessionStart;

        // 判断是否真的完成了
        const latest = readProgress(worktree);

        if (latest?.allComplete && (latest.testResults?.failed === 0 || latest.testResults?.failed == null)) {
          const outputFiles = await collectOutputFiles(worktree);
          logger.info('[AgentExecutor] Task completed', { taskId: task.id, executionId: task.executionId, sessionCount, cumulativeSessionMs });
          return { success: true, worktree, outputFiles, logFile, sessionCount, totalDurationMs: cumulativeSessionMs, sessionIds: collectedSessionIds };
        }

        // 5 次耗尽
        if (sessionCount >= this.config.maxSessions) {
          return {
            success: false, worktree, outputFiles: [],
            error: `Max sessions (${this.config.maxSessions}) exhausted without completion`,
            logFile, sessionCount, totalDurationMs: cumulativeSessionMs,
          };
        }

        // 未完成 → 继续下一轮
        logger.info('[AgentExecutor] Session incomplete, re-spawning', {
          taskId: task.id, executionId: task.executionId,
          session: sessionCount,
          stuckCount,
          currentStep: latest?.currentStep || 'unknown',
          sessionMs: Date.now() - sessionStart,
          cumulativeSessionMs,
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, worktree, outputFiles: [], error: errorMessage, logFile, sessionCount: 0 };
    } finally {
      this.runningProcesses.delete(task.executionId);
    }

    return { success: false, worktree, outputFiles: [], error: 'Unreachable', logFile, sessionCount: 0 };
  }

  // ========================================
  // 前置检查
  // ========================================

  // 实现移至 prerequisite-checks.ts（零行为变更）
  async checkPrerequisites(provider: ProviderId = 'claude'): Promise<PrerequisiteCheck[]> {
    return checkPrerequisites(this.config, provider);
  }

  // ========================================
  // Prompt 构建
  // ========================================

  // 实现移至 prompt-builder.ts（零行为变更）
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
  // 进程控制
  // ========================================

  /**
   * Stop a running execution by killing its child process.
   */
  async stop(executionId: string): Promise<void> {
    // Try exact match first, then prefix match
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
      logger.info('[AgentExecutor] Stopping child process', { executionId });
      childRef.current.kill('SIGTERM');
      this.runningProcesses.delete(executionId);

      // Force kill after 5s if still alive
      setTimeout(() => {
        if (childRef?.current) {
          logger.warn('[AgentExecutor] SIGTERM grace period expired, force SIGKILL', { executionId });
          try { childRef.current.kill('SIGKILL'); } catch { logger.warn('[AgentExecutor] SIGKILL failed', { executionId }); }
        }
      }, 5000);
    } else {
      logger.info('[AgentExecutor] Stop requested but no child process found', { executionId });
    }
  }

  getStatus(): { config: ExecutorConfig } {
    return { config: this.config };
  }
}

export const agentExecutor = new AgentExecutor();
