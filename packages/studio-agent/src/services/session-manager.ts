/**
 * Session Manager — Agent 执行器核心（session loop + async spawn）
 *
 * P11-02: Extracted from agent-executor.ts
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
import { logger, getModelForTier, buildSpawnEnv, parseStreamEvents, extractResult, extractToolCalls, extractFilePath } from '@dommaker/studio-shared';
import { execSh, resolveSessionId, readSessionIdFile } from '@dommaker/studio-shared/node';
import { prisma } from '@dommaker/studio-prisma';
import { beforeAgentExecute, buildAgentConstraintPrompt } from '@dommaker/studio-shared/harness/hooks';
import { skillLoader, type SkillTier } from '@dommaker/studio-skill';

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
  agentType: 'codex' | 'claude';
  model?: string;
  prompt: string;
  notifyTarget?: string;
  parameters?: Record<string, unknown>;
  /** 实时进度回调 — 每轮 session 后调用，用于推送到 Channel */
  onProgress?: (progress: ProgressReport, session: number) => Promise<void>;
  /** P3: 覆盖 tier 默认超时 (ms)。提供时替代 getSessionTimeout(tier)。 */
  timeoutMs?: number;
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
}

// ─── 前置检查结果 ───

export interface PrerequisiteCheck {
  name: string;
  passed: boolean;
  message: string;
  isWarning?: boolean;
}

const DEFAULT_SESSION_TIMEOUT = 30; // 分钟
const DEFAULT_MAX_SESSIONS = 5;

/** 策略切换指令 — 逐级升级 */
const STRATEGY_HINTS: Record<number, string> = {
  0: '',
  1: `⚠️ 上次 session 停在同一个步骤无进展。不要重复相同的尝试。换一种实现思路，先解释你打算尝试的新方法（2-3 句），再动手。`,
  2: `⚠️⚠️ 已经连续 2 次卡在同一处。缩小范围：只做当前步骤最核心的部分，跳过边缘情况。写完最小实现后立即跑测试验证。`,
  3: `⚠️⚠️⚠️ 严重阻塞 — 连续 3 次无进展。强制切换模式：1) 先不要写代码，读 REQUIREMENTS.md 和现有代码；2) 写出 3 步以内的 mini plan；3) 只实现第 1 步，跑测试；4) 跑通后再继续`,
  4: `🔴 最后一次机会 — 放弃当前方向，从第 0 行重新开始，用最简单、最朴素的方式实现（哪怕代码丑），先让测试通过。`,
};

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
      const checks = await this.checkPrerequisites();
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
        const isFirstSession = sessionCount === 1;
        const sessionFlag = isFirstSession
          ? (isNewSession
              ? `--session-id ${sessionId} --name "executor-${task.executionId.slice(0, 8)}"`
              : '--continue')
          : '--continue';

        const model = getModelForTier((task.model as 'fast' | 'standard' | 'premium') || 'standard');

        // Write prompt to file, pipe via stdin (same pattern as SessionManager)
        const promptFile = path.join(worktree, '.daemon', 'prompt.md');
        fsSync.mkdirSync(path.dirname(promptFile), { recursive: true });
        fsSync.writeFileSync(promptFile, prompt, 'utf-8');

        // O1c: Restrict tool access to verified files (prevents exploration drift)
        const _analystCtx = (task.parameters?.analystContext as any) || null;
        const _restrictDirs = _analystCtx?.verifiedFiles as string[] | undefined;
        const addDirArgs = _restrictDirs?.length
          ? _restrictDirs.map((f: string) => {
              const dir = f.split('/').slice(0, -1).join('/');
              return `--add-dir "${dir}"`;
            }).join(' ')
          : '';

        const cmd = [
          `cd "${worktree}"`,
          `&&`,
          `claude`,
          `--print`,
          `--output-format stream-json`,
          `--verbose`,
          addDirArgs,
          sessionFlag,
          `<`,
          `"${promptFile}"`,
          `2>&1`,
        ].filter(Boolean).join(' ');

        logger.info('[AgentExecutor] Spawning session', {
          taskId: task.id,
          executionId: task.executionId,
          session: sessionCount,
          isFirstSession,
          isNewSession,
          model,
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
              ...buildSpawnEnv({
                tier: (task.model as 'fast' | 'standard' | 'premium') || 'standard',
                role: 'executor',
                extra: {
                  STUDIO_EXECUTION_ID: task.executionId,
                  ...(task.parameters?.goalId ? { STUDIO_GOAL_ID: task.parameters.goalId as string } : {}),
                },
              }),
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

          // D4: Emit tool:call and file:change events
          // AS-021 #2: Include sessionId so session-summary-generator can correlate events
          const toolCalls = extractToolCalls(events);
          for (const tool of toolCalls) {
            try {
              await prisma.studioEvent.create({
                data: {
                  type: 'tool:call',
                  source: 'agent-executor',
                  executionId: task.executionId,
                  payload: JSON.stringify({ tool: tool.name, input: tool.input, sessionId }),
                },
              });
              const filePath = extractFilePath(tool.name, tool.input);
              if (filePath) {
                await prisma.studioEvent.create({
                  data: {
                    type: 'file:change',
                    source: 'agent-executor',
                    executionId: task.executionId,
                    payload: JSON.stringify({ path: filePath, action: 'write', sessionId }),
                  },
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
            modelTier: (task.model as string) || 'standard',
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
            const resolutions = await prisma.resolution.findMany({
              where: { status: { in: ['verified', 'canonical'] } },
              orderBy: { verifyCount: 'desc' },
            });
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

  async checkPrerequisites(): Promise<PrerequisiteCheck[]> {
    const checks: PrerequisiteCheck[] = [];
    logger.info('[AgentExecutor] Checking prerequisites', { repoDir: this.config.repoDir });

    // Claude Code CLI
    try {
      const { stdout } = await execSh('claude --version 2>&1 || echo "NOT_FOUND"', {
        cwd: '/tmp',
        timeoutMs: 10_000,
      });
      if (stdout.includes('NOT_FOUND')) {
        checks.push({ name: 'Claude Code CLI', passed: false, message: 'claude 命令不可用' });
      } else {
        checks.push({ name: 'Claude Code CLI', passed: true, message: stdout.trim().slice(0, 80) });
      }
    } catch {
      checks.push({ name: 'Claude Code CLI', passed: false, message: 'claude 命令不可用' });
    }

    // 磁盘空间
    try {
      const { stdout } = await execSh('df -h . | tail -1 | awk "{print \$4}"', {
        cwd: this.config.worktreesDir,
        timeoutMs: 5_000,
      });
      const cleaned = stdout.trim().replace(/[^0-9.]/g, '');
      const availableGB = parseInt(cleaned, 10);
      if (isNaN(availableGB)) {
        checks.push({ name: '磁盘空间', passed: true, message: `无法解析: "${stdout.trim()}"`, isWarning: true });
      } else {
        checks.push({
          name: '磁盘空间', passed: availableGB >= 5,
          message: `磁盘空间: ${availableGB}GB`,
          isWarning: availableGB < 5 && availableGB >= 2,
        });
      }
    } catch {
      checks.push({ name: '磁盘空间', passed: true, message: '无法检测', isWarning: true });
    }

    // worktrees 目录
    try {
      await fs.mkdir(this.config.worktreesDir, { recursive: true });
      checks.push({ name: 'worktrees 目录', passed: true, message: `目录可写: ${this.config.worktreesDir}` });
    } catch {
      checks.push({ name: 'worktrees 目录', passed: false, message: `目录不可写: ${this.config.worktreesDir}` });
    }

    // git repo
    try {
      await execSh('git rev-parse --git-dir', {
        cwd: this.config.repoDir,
        timeoutMs: 5_000,
      });
      checks.push({ name: 'Git Repo', passed: true, message: `主仓库: ${this.config.repoDir}` });
    } catch {
      checks.push({ name: 'Git Repo', passed: false, message: `${this.config.repoDir} 不是 git 仓库` });
    }

    return checks;
  }

  // ========================================
  // Prompt 构建
  // ========================================

  /**
   * 构建 Agent prompt
   *
   * Session 1: 简要指令 + 读 REQUIREMENTS.md
   * Session 2+: 极短续接（文件桥，上下文靠 worktree 文件）
   * 卡住时注入策略切换指令
   */
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
    // 约束注入
    const constraintPrompt = buildAgentConstraintPrompt({
      operation: 'code_implementation',
      taskDescription: task.prompt,
    });

    const rawConstraints = task.parameters?.roleConstraints;
    const roleConstraints: string[] = Array.isArray(rawConstraints) ? rawConstraints
      : typeof rawConstraints === 'string' ? JSON.parse(rawConstraints)
      : [];
    const roleConstraintSection = roleConstraints.length
      ? `\n## 角色约束\n以下约束优先于一般指导原则：\n${roleConstraints.map((c: string) => `- ${c}`).join('\n')}\n`
      : '';

    // G-001~003: 知识上下文（偏好 + 规则 + 环境 + 历史决策）
    const knowledgeSection = knowledgeContext
      ? `\n## 项目上下文\n${knowledgeContext}\n`
      : '';

    const constraintSection = constraintPrompt || roleConstraintSection || knowledgeSection
      ? (constraintPrompt + roleConstraintSection + knowledgeSection + '\n---\n\n')
      : '';

    // O2f/O2g: Output style compression per Agent role
    const OUTPUT_STYLE_MAP: Record<string, string> = {
      analyst: 'Output style: Be concise. Drop filler words (just, really, basically). No sycophantic openers or closing fluff. Keep complete sentences. Technical terms exact.',
      executor: 'Output style: Terse like caveman. Drop articles (a/an/the), filler words, pleasantries, hedging. Fragments OK. Short synonyms. Code blocks unchanged. Technical substance exact.',
      reviewer: 'Output style: Terse like caveman. Drop articles (a/an/the), filler words, pleasantries, hedging. Fragments OK. Short synonyms. Code blocks unchanged. Technical substance exact.',
      integration: 'Output style: Ultra-terse. Maximum compression. Telegraphic style. Drop all non-essential words. Code output only — no explanation unless error.',
      deploy: 'Output style: Be concise. Drop filler words. No fluff. Keep complete sentences. Technical terms exact.',
    };
    const outputStyleSection = `## 输出风格\n${OUTPUT_STYLE_MAP[role] || OUTPUT_STYLE_MAP.executor}\n\n`;

    // O2i: Skill on-demand injection
    const skillTier = (task.model as SkillTier) || 'standard';
    const skillsToInject = skillLoader.load({ agentType: 'executor', tier: skillTier });
    const skillPrompt = skillLoader.formatForPrompt(skillsToInject);

    if (session === 1 || !progress) {
      // O1c: Inject Analyst context to prevent re-exploring verified files
      const analystContext = (task.parameters?.analystContext as any) || null;
      const analystContextSection = analystContext ? [
        '## 已有分析上下文（来自 Analyst 探索）',
        '',
        `**已验证文件** (不需要重新探索): ${(analystContext.verifiedFiles || []).join(', ')}`,
        analystContext.architectureContext ? `\n**架构说明**: ${analystContext.architectureContext}` : '',
        analystContext.gotchas?.length ? `\n**注意事项**: ${analystContext.gotchas.join('; ')}` : '',
        '',
        '只修改上述文件。如需查看额外文件，说明原因——Scheduler 将添加权限后继续。',
        '',
      ].join('\n') : '';

      const verifyStep = acGroup?.architectureContext
        ? '\n⚠️ REQUIREMENTS.md 包含架构上下文（Analyst 已探索的代码位置和签名）。\n第一步必须是验证关键函数签名和行号是否仍然有效，如果已偏移请修正后再实现。\n'
        : '';
      const base = `${constraintSection}${outputStyleSection}${analystContextSection}## 你的任务
${task.prompt}


读 REQUIREMENTS.md 了解你要完成的任务和验收标准。${verifyStep}
${skillPrompt}

## 完成后必须提交
所有 AC 满足且测试通过后，执行 git 操作：
1. \`git add\` 你修改的所有文件
2. \`git commit -m "feat: <简要描述改动>"\` 提交代码
3. 然后设置 allComplete: true
不要跳过 commit —— 代码未提交视为未完成。`;
      return resolutionHint ? `${base}\n\n${resolutionHint}` : base;
    }

    // Session 2+: 极短续接 prompt
    const hintLevel = Math.min(stuckCount, 4);
    const strategyHint = STRATEGY_HINTS[hintLevel];
    const parts = [
      `${constraintSection}${outputStyleSection}## 续接任务`,
      '',
      '读 REQUIREMENTS.md 了解任务。',
      '读 .progress.json 了解进度。',
      '',
      `你上次做到：${progress.currentStep || '未知'}`,
      `已完成：${progress.completedSteps?.join(', ') || '无'}`,
      `测试结果：${progress.testResults?.passed || 0} passed / ${progress.testResults?.failed || 0} failed`,
      `备注：${progress.notes || '无'}`,
    ];
    if (skillPrompt) parts.push('', skillPrompt);
    if (strategyHint) parts.push('', strategyHint);
    if (resolutionHint) parts.push('', resolutionHint);
    parts.push('', '继续工作，从上次中断的地方开始。每完成一步后更新 .progress.json。');
    parts.push('全部完成后 git add 你修改的文件 && git commit，然后设置 allComplete: true。');
    return parts.join('\n');
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
