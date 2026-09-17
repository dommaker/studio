/**
 * Runner Lightweight — 轻量单 session 执行（agent-runner.ts 拆分模块）
 *
 * 从 agent-runner.ts 按职责拆出的执行路径（P9: Daemon→AgentRunner），#562 起是本包
 * 唯一执行路径：worktree + harness 配置 + 单 session 一次 spawn。
 * 与已删除的多 session 循环曾共享的依赖面：provider 注册表（spawn 模板）、
 * propagateHarnessConfig（含 provider-hooks 执法配置与 CLAUDE.md 复制）、
 * 知识注入（buildAugmentedPrompt）、output-capture（进度读取/事件发射/session 指标）；
 * harness hooks 层则已整层删除，本路径不再调任何 hook。
 *
 * 零行为变更：函数体自 AgentRunner.executeLightweight() 平移；
 * 实例状态经 RunnerExecutionState 传入。
 */

import type { ChildProcess } from 'child_process';
import * as path from 'path';
import * as fsSync from 'fs';
import { logger } from '@dommaker/studio-shared';
import { execSh, classifyCliFailure } from '@dommaker/studio-shared/node';

import { resolveWorkspace, propagateHarnessConfig } from './worktree-resolver.js';
import {
  emitSessionStart,
  emitSessionEnd,
} from './output-capture.js';
import { processSessionOutput } from './runner-output.js';
import {
  checkPrerequisites,
  buildAugmentedPrompt,
  buildSessionCommand,
  buildSessionEnv,
} from './runner-params.js';

import type { AgentTask, ExecutionResult, RunnerExecutionState } from './types.js';

// ========================================
// Lightweight mode (P9: Daemon→AgentRunner)
// ========================================

/**
 * Lightweight execution: worktree + harness + single session.
 * Keeps: resolveWorkspace, checkPrerequisites, propagateHarnessConfig,
 *        knowledge context, session resume channel, stream-json parsing,
 *        event emission, metrics.
 * No longer exists anywhere: the multi-session loop with its stuck detection,
 *        contract tests and dependency cache (deleted in #562).
 *
 * Caller provides the full prompt — this path builds no prompt text of its own.
 * Session 续接唯一通道：parameters.sessionId + parameters.sessionResume，经
 * cli-adapter 按 provider 生成（claude 续用为 --resume；其余 provider 走 cwd 维度
 * 续用，见 cli-adapter.ts 实证记录）。#587 起旧 daemon 链路那条原样拼接 claude
 * flag 的通道已随其生产者一并移除。
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

    // Session 续接由调用方经 parameters 给出（sessionId + sessionResume），cli-adapter
    // 按 provider 换语法；本路径不再原样拼接任何 provider 专属 session flag。
    const provider = task.provider || 'claude';
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
    });

    logger.info('[AgentRunner] Lightweight session spawning', {
      taskId: task.id, executionId: task.executionId,
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
        sessionExtras, // #361: session:end 与 session:start 携带同一份 extras（单形态）
      });

      if (isError) {
        logger.warn('[AgentRunner] Lightweight session returned error', {
          taskId: task.id, text: text.slice(0, 200),
        });
        // #565: 失败分类——命中已知特征时带出「去哪修」指引；未命中行为与现状一致
        const failureClass = classifyCliFailure({ provider, output: text });
        return {
          success: false, worktree, outputFiles: [],
          error: failureClass ? `[${failureClass.category}] ${failureClass.guidance} — ${text.slice(0, 500)}` : text.slice(0, 500),
          ...(failureClass ? { failureClass } : {}),
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

      await emitSessionEnd(sessionId, task.executionId, 1, sessionExtras);

      // #565: 失败分类——errMsg/stdout 命中已知特征时带出指引；未命中行为与现状一致
      const failureClass = classifyCliFailure({
        provider,
        exitCode: typeof (execErr as { code?: unknown })?.code === 'number' ? (execErr as { code: number }).code : undefined,
        output: `${errMsg}\n${stdoutText}`,
      });
      return {
        success: false, worktree, outputFiles: [],
        error: failureClass ? `[${failureClass.category}] ${failureClass.guidance} — ${errMsg.slice(0, 500)}` : errMsg.slice(0, 500),
        ...(failureClass ? { failureClass } : {}),
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
