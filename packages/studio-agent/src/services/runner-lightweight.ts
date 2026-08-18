/**
 * Runner Lightweight — 轻量单 session 执行（agent-runner.ts 拆分模块）
 *
 * 从 agent-runner.ts 按职责拆出的 lightweight 执行路径（P9: Daemon→AgentRunner）：
 *   worktree + harness + 单 session；跳过 SDD 解析、REQUIREMENTS.md、contract tests、
 *   Iron Laws、依赖缓存、卡死检测与多 session 循环。
 *
 * 零行为变更：函数体自 AgentRunner.executeLightweight() 平移；
 * 实例状态经 RunnerExecutionState 传入。
 */

import type { ChildProcess } from 'child_process';
import * as path from 'path';
import * as fsSync from 'fs';
import { logger } from '@dommaker/studio-shared';
import { execSh } from '@dommaker/studio-shared/node';

import { resolveWorkspace, propagateHarnessConfig } from './worktree-resolver.js';
import {
  emitSessionStart,
  emitSessionEnd,
  recordExecutionError,
} from './output-capture.js';
import { processSessionOutput } from './runner-output.js';
import {
  checkPrerequisites,
  buildAugmentedPrompt,
  buildSessionCommand,
  buildSessionEnv,
} from './runner-params.js';
import type { RunnerExecutionState } from './runner-execution.js';

import type { AgentTask, ExecutionResult } from './types.js';

// ========================================
// Lightweight mode (P9: Daemon→AgentRunner)
// ========================================

/**
 * Lightweight execution: worktree + harness + single session.
 * Skips: SDD resolution, REQUIREMENTS.md, contract tests, Iron Laws,
 *        dependency cache, stuck detection, multi-session loop.
 * Keeps: resolveWorktree, propagateHarnessConfig, session-id/continue,
 *        stream-json parsing, event emission, metrics.
 *
 * Caller provides the full prompt — no buildPrompt enrichment.
 * Session 语义两个通道：旧 daemon 链路走 parameters.sessionFlags（claude --session-id/--continue
 * 原样拼接）；agent-loop 链路走 parameters.sessionId + parameters.sessionResume
 * （经 cli-adapter 按 provider 生成，claude 续用为 --resume）。
 */
export async function executeLightweightSession(state: RunnerExecutionState, task: AgentTask): Promise<ExecutionResult> {
  const { config, runningProcesses } = state;
  logger.info('[AgentRunner] Lightweight execution', { taskId: task.id, executionId: task.executionId });

  let worktree: string;
  try {
    worktree = await resolveWorkspace({
      task,
      worktreesDir: config.worktreesDir,
      repoDir: config.repoDir,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, worktree: '', outputFiles: [], error: errorMessage, logFile: '', sessionCount: 0 };
  }

  const logFile = path.join(worktree, '.agent.log');

  try {
    // Prerequisite checks (keep — fast validation)
    const checks = await checkPrerequisites(config, task.provider || 'claude');
    const errors = checks.filter(c => !c.passed && !c.isWarning);
    if (errors.length > 0) {
      throw new Error(`前置检查失败: ${errors.map(e => e.message).join(', ')}`);
    }

    // Propagate harness config (keep — gives daemon access to harness rules)
    await propagateHarnessConfig(worktree, task.id, task.executionId, config.repoDir);

    // Knowledge context injection (GAP-5a: AC-5a.1, AC-5a.2, AC-5a.3)
    const knowledgeContext = task.parameters?.knowledgeContext as string | undefined;
    const augmentedPrompt = buildAugmentedPrompt(task.prompt, knowledgeContext);

    // Write prompt (with knowledge context if present)
    const promptFile = path.join(worktree, '.daemon', 'prompt.md');
    fsSync.mkdirSync(path.dirname(promptFile), { recursive: true });
    fsSync.writeFileSync(promptFile, augmentedPrompt, 'utf-8');

    // Session management — caller provides flags via parameters
    // F4: sessionFlags 是 claude 专属语法（--session-id/--continue）；其它 provider 的
    // session 由 registry spawn 模板处理（buildSpawnArgs 传入 parameters.sessionId）。
    // 核查（fix/guard-and-resume）：sessionFlags 唯一设置方是旧 daemon 链路
    // apps/api/src/daemon/session-manager.ts（首 task --session-id、后续 --continue，无 Bug B）；
    // agent-loop 链路不用它 —— 走 parameters.sessionId + parameters.sessionResume（见下）。
    const provider = task.provider || 'claude';
    const sessionFlags = provider === 'claude' ? ((task.parameters?.sessionFlags as string) || '') : '';
    const agentRole = (task.parameters?.agentRole as string) || 'executor';
    const sessionId = task.executionId;

    // Use cli-adapter for provider-specific spawn args
    const cmd = buildSessionCommand({
      provider,
      spawnParams: {
        worktreeDir: worktree,
        sessionId: task.parameters?.sessionId as string | undefined,
        // 续用标记（agent-loop）：claude 换 --resume，其余 provider 模板不变
        sessionResume: task.parameters?.sessionResume === true,
        maxTurns: task.parameters?.maxTurns as number | undefined,
      },
      worktree,
      promptFile,
      sessionFlags,
    });

    logger.info('[AgentRunner] Lightweight session spawning', {
      taskId: task.id, executionId: task.executionId, sessionFlags,
    });

    const childRef: { current: ChildProcess | null } = { current: null };
    runningProcesses.set(task.executionId, childRef);

    const sessionStart = Date.now();
    // #174: session:start/end 事件补 workUnitId + transcript 归档路径（来自 agent-loop 注入的 parameters）
    const sessionExtras = {
      workUnitId: task.parameters?.workUnitId as string | undefined,
      transcriptPath: task.parameters?.transcriptPath as string | undefined,
    };
    await emitSessionStart(sessionId, task.executionId, 1, sessionExtras);

    try {
      const { stdout } = await execSh(cmd, {
        cwd: worktree,
        env: buildSessionEnv({ task, role: agentRole as 'analyst' | 'executor', withWorkUnitEnv: true, worktree }),
        // 扁平默认 30min（原 fast/standard/premium tier 分档已删）
        timeoutMs: task.timeoutMs ?? 30 * 60_000,
        maxBuffer: 10 * 1024 * 1024,
        childRef,
        // #171（#54 决议）：杀步 = 杀进程组（#68 实测 SIGTERM 杀不死孙进程，孤儿继续烧 token）；
        // 静默看门狗判据 = 距最后一次输出间隔，仅任务显式配置 silenceKillMs 时启用。
        killProcessGroup: true,
        silence: task.silenceKillMs
          ? { warnMs: task.silenceWarnMs, killMs: task.silenceKillMs, onWarn: task.onSilenceWarn }
          : undefined,
        // Layer B: 步内行级透传（agent-loop → SSE 实时过程；undefined 时零开销）
        onLine: task.onStreamLine,
      });

      const sessionMs = Date.now() - sessionStart;
      const { text, isError, streamUsage } = await processSessionOutput(stdout, {
        logFile,
        sessionId,
        executionId: task.executionId,
        sessionCount: 1,
        isFirstSession: true,
        sessionMs,
        agentRole,
        promptSize: task.prompt.length,
        provider, // #134: usage 提取按 provider 分流
      });

      if (isError) {
        logger.warn('[AgentRunner] Lightweight session returned error', {
          taskId: task.id, text: text.slice(0, 200),
        });
        return {
          success: false, worktree, outputFiles: [], error: text.slice(0, 500),
          logFile, sessionCount: 1, totalDurationMs: sessionMs, sessionIds: [sessionId],
          usage: streamUsage, // M2: 失败执行同样计 tokens
        };
      }

      logger.info('[AgentRunner] Lightweight session completed', {
        taskId: task.id, executionId: task.executionId, sessionMs,
      });

      return {
        success: true, worktree, outputFiles: [], logFile,
        sessionCount: 1, totalDurationMs: sessionMs, sessionIds: [sessionId],
        outputText: text || undefined,
        rawOutput: stdout, // R2: 原始 stream-json，供 agent-loop 提取 tool:call 事件
        usage: streamUsage, // M2: 透出 CLI usage，供 agent-loop 记录 workunit:tokens
      };
    } catch (execErr) {
      const errMsg = execErr instanceof Error ? execErr.message : String(execErr);
      const stdoutText = execErr?.stdout?.toString().slice(0, 2000) || '';
      const stderrText = execErr?.stderr?.toString().slice(0, 500) || '';

      await recordExecutionError({
        executionId: task.executionId, errMsg, errStack: execErr?.stack?.slice(0, 2000),
        stderrText, stdoutText, sessionCount: 1, cumulativeSessionMs: Date.now() - sessionStart,
        signal: execErr?.signal, code: execErr?.code,
      });

      await emitSessionEnd(sessionId, task.executionId, 1, sessionExtras);

      return {
        success: false, worktree, outputFiles: [],
        error: errMsg.slice(0, 500),
        failureLog: stdoutText ? stdoutText.slice(-1000) : undefined,
        logFile, sessionCount: 1, totalDurationMs: Date.now() - sessionStart,
        sessionIds: [sessionId],
      };
    } finally {
      runningProcesses.delete(task.executionId);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, worktree, outputFiles: [], error: errorMessage, logFile, sessionCount: 0 };
  }
}
