/**
 * Runner Execution — session loop 执行（agent-runner.ts 拆分模块）
 *
 * 从 agent-runner.ts 按职责拆出的多 session 执行循环：
 *   workspace 解析 → 前置检查 → harness/依赖/REQUIREMENTS 桥接 →
 *   loop(spawn CLI → stream-json 解析 → 进度/卡死判定 → 续接或失败) → 结果汇总
 *
 * 零行为变更：循环体自 AgentRunner.execute() 平移；实例状态经 RunnerExecutionState 传入。
 */

import type { ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { logger, parseStreamEvents, extractToolCalls, extractFilePath as extractFilePathShared, extractResult, extractUsage } from '@dommaker/studio-shared';
import { execSh, resolveSessionId, readSessionIdFile } from '@dommaker/studio-shared/node';
import { beforeAgentExecute } from '@dommaker/studio-shared/harness/hooks';

import {
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
  emitToolCall,
  emitFileChange,
  recordExecutionError,
  getConstraintMeta,
} from './output-capture.js';
import {
  buildPrompt,
  resolveSddTaskData,
  checkPrerequisites,
  buildSessionFlag,
  buildAddDirArgs,
  buildSessionCommand,
  buildSessionEnv,
} from './runner-params.js';
import { hasRecentActivity, queryResolutionHints } from './runner-output.js';

import type { ExecutorConfig, AgentTask, ExecutionResult } from './session-manager.js';

/** 执行所需的实例状态（由 AgentRunner 门面传入，避免模块反向依赖类）。 */
export interface RunnerExecutionState {
  config: ExecutorConfig;
  runningProcesses: Map<string, { current: ChildProcess | null }>;
}

// ========================================
// Execute (session loop)
// ========================================

export async function executeSessionLoop(state: RunnerExecutionState, task: AgentTask): Promise<ExecutionResult> {
  const { config, runningProcesses } = state;
  logger.info('[AgentRunner] Starting session loop', { taskId: task.id, executionId: task.executionId });

  let worktree: string;
  try {
    worktree = await resolveWorkspace({
      task,
      worktreesDir: config.worktreesDir,
      repoDir: config.repoDir,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const fallbackLog = path.join(config.worktreesDir, task.executionId, '.agent.log');
    return { success: false, worktree: '', outputFiles: [], error: errorMessage, logFile: fallbackLog, sessionCount: 0 };
  }

  // Derive logFile from resolved worktree path (not config.worktreesDir)
  const logFile = path.join(worktree, '.agent.log');

  try {
    // Step 1: prerequisite checks
    const checks = await checkPrerequisites(config, task.provider || 'claude');
    const errors = checks.filter(c => !c.passed && !c.isWarning);
    if (errors.length > 0) {
      throw new Error(`\u524d\u7f6e\u68c0\u67e5\u5931\u8d25: ${errors.map(e => e.message).join(', ')}`);
    }

    // Step 2: propagate harness config
    await propagateHarnessConfig(worktree, task.id, task.executionId, config.repoDir);

    // Step 2.5: pre-populate node_modules (dependency cache)
    await ensureDeps(worktree, config.repoDir);

    // Write cache prefix
    try {
      const prefixPath = path.join(worktree, 'CACHE_PREFIX.md');
      if (!fsSync.existsSync(prefixPath)) {
        const shared = buildCachePrefix(config.repoDir);
        fsSync.writeFileSync(prefixPath, shared, 'utf-8');
      }
    } catch { /* non-blocking */ }

    // Iron Laws check
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

    // SP-004 Step 5: resolve contractTests + testFiles from SDD task layer (fallback DB)
    const sddTaskData = await resolveSddTaskData(task);
    const contractTests = sddTaskData.contractTests;
    const testFiles = sddTaskData.testFiles;

    // Write REQUIREMENTS.md (with testFiles for GREEN phase verification)
    const acGroup = task.parameters?.acGroup as Record<string, any> | undefined;
    await writeRequirementsMd(worktree, task, acGroup, testFiles);

    // Write contract tests (RED phase)
    if (contractTests?.length) {
      await writeContractTests(worktree, contractTests);
    }

    // Session loop
    let sessionCount = 0;
    let stuckCount = 0;
    let lastStep = '';
    let lastCompletedCount = 0;
    let cumulativeSessionMs = 0;
    let resolutionHint = '';
    let cumulativeInputTokens = 0;
    let cumulativeOutputTokens = 0;
    let cumulativeCacheHitTokens = 0;
    let cumulativeCacheCreationTokens = 0;
    const perSessionBreakdown: Array<{ session: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; durationMs: number }> = [];

    const goalId = (task.parameters?.goalId as string) || task.executionId;

    // Per-execution session isolation — each executionId gets its own session.
    // Retry loops within same execution reuse via --continue.
    const execSessionDir = path.join(config.worktreesDir, '.execution-sessions', task.executionId);
    const execSessionFile = path.join(execSessionDir, 'session-id');

    let sessionId: string;
    let isNewSession: boolean;
    const collectedSessionIds: string[] = [];

    const existingId = fsSync.existsSync(execSessionFile)
      ? readSessionIdFile(worktree, { sessionIdFile: execSessionFile })
      : null;
    if (existingId) {
      sessionId = existingId;
      isNewSession = false;
    } else {
      sessionId = resolveSessionId(worktree, { sessionIdFile: execSessionFile });
      isNewSession = true;
    }

    logger.info('[AgentRunner] Session resolved', {
      executionId: task.executionId,
      sessionId: sessionId.slice(0, 8),
      isNewSession,
      sessionScope: 'per-execution',
      goalId,
      worktree,
    });

    while (sessionCount < config.maxSessions) {
      sessionCount++;

      // Ensure file bridge exists
      const reqPath = path.join(worktree, 'REQUIREMENTS.md');
      if (!fsSync.existsSync(reqPath)) {
        fsSync.mkdirSync(worktree, { recursive: true });
        logger.warn('[AgentRunner] REQUIREMENTS.md missing, re-writing', { taskId: task.id, executionId: task.executionId, session: sessionCount });
        await writeRequirementsMd(worktree, task, acGroup, testFiles);
        if (contractTests?.length) {
          await writeContractTests(worktree, contractTests);
        }
      }

      // Read progress
      const progress = readProgress(worktree);

      // Progress callback
      if (task.onProgress && progress) {
        task.onProgress(progress, sessionCount).catch(() => {});
      }

      // Stuck detection — baseline tracking only.
      // Actual stuck detection is done post-session (after spawn) to avoid
      // comparing stale progress data. See T2 post-session stuck check.
      const currentStep = progress?.currentStep || '';
      const completedCount = progress?.completedSteps?.length || 0;
      lastStep = currentStep;
      lastCompletedCount = completedCount;

      // Build prompt
      const knowledgeContext = (task.parameters?.knowledgeContext as string) || '';
      const prompt = buildPrompt(task, progress, sessionCount, acGroup, stuckCount, knowledgeContext, resolutionHint);
      fsSync.mkdirSync(worktree, { recursive: true });
      await fs.writeFile(path.join(worktree, '.prompt.md'), prompt, 'utf-8');

      // Session flags
      // F4: --session-id/--continue/--name 是 claude 专属语法；其它 provider 的 session
      // 由 registry spawn 模板处理（cli-adapter）。非 claude 的跨 session 续接仍是 claude-only。
      const provider = task.provider || 'claude';
      const isFirstSession = sessionCount === 1;
      const sessionFlag = buildSessionFlag(provider, sessionCount, isNewSession, sessionId, task.executionId);

      // Write prompt file
      const promptFile = path.join(worktree, '.daemon', 'prompt.md');
      fsSync.mkdirSync(path.dirname(promptFile), { recursive: true });
      fsSync.writeFileSync(promptFile, prompt, 'utf-8');

      // Restrict tool access
      const addDirArgs = buildAddDirArgs(task, provider);

      // AC1.1: Use stream-json output format via cli-adapter
      const cmd = buildSessionCommand({
        provider,
        spawnParams: { worktreeDir: worktree },
        worktree,
        promptFile,
        sessionFlags: sessionFlag,
        addDirArgs,
      });

      logger.info('[AgentRunner] Spawning session', {
        taskId: task.id,
        executionId: task.executionId,
        session: sessionCount,
        isFirstSession,
        isNewSession,
      });

      const childRef: { current: ChildProcess | null } = { current: null };
      runningProcesses.set(task.executionId, childRef);

      const sessionStart = Date.now();
      collectedSessionIds.push(sessionId);

      await emitSessionStart(sessionId, task.executionId, sessionCount);

      try {
        const { stdout } = await execSh(cmd, {
          cwd: worktree,
          env: buildSessionEnv({ task, role: 'executor' }),
          // 扁平默认 30min（原 fast/standard/premium tier 分档已删）
          timeoutMs: task.timeoutMs ?? 30 * 60_000,
          maxBuffer: 10 * 1024 * 1024,
          childRef,
        });

        fsSync.writeFileSync(logFile, stdout, 'utf-8');

        // AC1.1 + AC1.3: Parse stream-json line by line
        const events = parseStreamEvents(stdout);
        const { text, isError } = extractResult(events);
        const streamUsage = extractUsage(events);

        // Accumulate tokens across sessions for summary
        cumulativeInputTokens += streamUsage?.inputTokens || 0;
        cumulativeOutputTokens += streamUsage?.outputTokens || 0;
        cumulativeCacheHitTokens += streamUsage?.cacheReadTokens || 0;
        cumulativeCacheCreationTokens += streamUsage?.cacheCreationTokens || 0;
        perSessionBreakdown.push({
          session: sessionCount,
          inputTokens: streamUsage?.inputTokens || 0,
          outputTokens: streamUsage?.outputTokens || 0,
          cacheReadTokens: streamUsage?.cacheReadTokens || 0,
          cacheCreationTokens: streamUsage?.cacheCreationTokens || 0,
          durationMs: Date.now() - sessionStart,
        });

        // AC1.3: Emit tool:call and file:change events
        const tools = extractToolCalls(events);
        for (const tool of tools) {
          await emitToolCall(tool.name, tool.input, sessionId, task.executionId);
          const filePath = extractFilePathShared(tool.name, tool.input);
          if (filePath) {
            await emitFileChange(filePath, sessionId, task.executionId);
          }
        }

        if (isError) {
          logger.warn('[AgentRunner] Claude Code returned error', { taskId: task.id, executionId: task.executionId, session: sessionCount, text: text.slice(0, 200) });
        }

        // Record session metrics
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
          streamUsage,
        });

        await emitSessionEnd(sessionId, task.executionId, sessionCount);
      } catch (execErr: any) {
        const errMsg = execErr instanceof Error ? execErr.message : String(execErr);
        const errStack = execErr instanceof Error ? execErr.stack?.slice(0, 2000) : undefined;
        // 2>&1 重定向 stderr→stdout，stderr 为空；实际错误信息在 stdout
        const stdoutText = execErr?.stdout?.toString().slice(0, 2000) || '';
        const stderrText = execErr?.stderr?.toString().slice(0, 500) || '';

        cumulativeSessionMs += Date.now() - sessionStart;
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

        // Emit session:end on failure path — without this, failed sessions leak (163 starts / 74 ends)
        await emitSessionEnd(sessionId, task.executionId, sessionCount);

        logger.warn('[AgentRunner] Session failed', {
          taskId: task.id, executionId: task.executionId,
          session: sessionCount, sessionMs: Date.now() - sessionStart,
          cumulativeSessionMs,
          error: errMsg.slice(0, 200),
          stdout: stdoutText.slice(0, 500),
        });

        // RKB: query known resolutions
        const hint = await queryResolutionHints(errMsg);
        if (hint) resolutionHint = hint;

        if (sessionCount >= config.maxSessions) {
          // stdout 包含 claude 实际输出（含错误详情），errMsg 可能因 2>&1 为空
          const detail = stdoutText ? stdoutText.slice(-500) : errMsg.slice(0, 200);
          const failureLog = [
            `## Session ${sessionCount} Failure`,
            `### Error: ${errMsg}`,
            errStack ? `### Stack:\n${errStack}` : '',
            stdoutText ? `### Stdout:\n${stdoutText}` : '',
            stderrText ? `### Stderr:\n${stderrText}` : '',
          ].filter(Boolean).join('\n');
          logger.info('[AgentRunner] Session token summary', {
            executionId: task.executionId,
            sessionId: sessionId.slice(0, 8),
            sessionScope: 'per-execution',
            goalId,
            totalInputTokens: cumulativeInputTokens,
            cacheReadTokens: cumulativeCacheHitTokens,
            cacheCreationTokens: cumulativeCacheCreationTokens,
            cacheHitRate: cumulativeInputTokens > 0
              ? Math.round(cumulativeCacheHitTokens / cumulativeInputTokens * 100) : 0,
            outputTokens: cumulativeOutputTokens,
            sessionCount,
            durationMs: cumulativeSessionMs,
            perSessionBreakdown,
          });
          return {
            success: false, worktree, outputFiles: [],
            error: `Max sessions (${config.maxSessions}) exhausted. Last error: ${detail}`,
            failureLog,
            logFile, sessionCount,
          };
        }
        continue;
      }

      // After first successful session
      isNewSession = false;
      cumulativeSessionMs += Date.now() - sessionStart;

      const latest = readProgress(worktree);

      // T2: Session 1 zero-progress fast-fail — if first session produced nothing,
      // don't burn 4 more sessions. Bail immediately.
      if (sessionCount === 1) {
        const completedCount = latest?.completedSteps?.length || 0;
        const hasTestResults = !!(latest?.testResults && (latest.testResults.total > 0 || latest.testResults.passed > 0));
        if (completedCount === 0 && !hasTestResults && !latest?.allComplete) {
          logger.warn('[AgentRunner] Session 1 produced zero progress — fast failing', {
            taskId: task.id, executionId: task.executionId,
            currentStep: latest?.currentStep || 'unknown',
          });
          const failureLog = [
            `## Session 1 Zero Progress`,
            `### Progress: ${JSON.stringify(latest, null, 2)}`,
            `### No file changes, no test results, not complete.`,
          ].join('\n');
          return {
            success: false, worktree, outputFiles: [],
            error: `Session 1 produced zero progress — aborting to save tokens`,
            failureLog,
            logFile, sessionCount, totalDurationMs: cumulativeSessionMs,
          };
        }
      }

      if (latest?.allComplete && (latest.testResults?.failed === 0 || latest.testResults?.failed == null)) {
        const outputFiles = await collectOutputFiles(worktree);
        logger.info('[AgentRunner] Session token summary', {
          executionId: task.executionId,
          sessionId: sessionId.slice(0, 8),
          sessionScope: 'per-execution',
          goalId,
          totalInputTokens: cumulativeInputTokens,
          cacheReadTokens: cumulativeCacheHitTokens,
          cacheCreationTokens: cumulativeCacheCreationTokens,
          cacheHitRate: cumulativeInputTokens > 0
            ? Math.round(cumulativeCacheHitTokens / cumulativeInputTokens * 100) : 0,
          outputTokens: cumulativeOutputTokens,
          sessionCount,
          durationMs: cumulativeSessionMs,
          perSessionBreakdown,
        });
        logger.info('[AgentRunner] Task completed', { taskId: task.id, executionId: task.executionId, sessionCount, cumulativeSessionMs });
        return { success: true, worktree, outputFiles, logFile, sessionCount, totalDurationMs: cumulativeSessionMs, sessionIds: collectedSessionIds };
      }

      // T2: Post-session stuck check — if progress hasn't changed, fail fast
      // instead of injecting strategy hints and wasting more sessions.
      const postCompletedCount = latest?.completedSteps?.length || 0;
      if (postCompletedCount <= completedCount && !latest?.allComplete) {
        // P1-2: Defer stuck if worktree has recent file activity (npm install, tsc, etc)
        if (hasRecentActivity(worktree)) {
          logger.info('[AgentRunner] Stuck deferred — recent file activity detected', {
            taskId: task.id, executionId: task.executionId, session: sessionCount, worktree,
          });
        } else {
          stuckCount++;
        }
        if (stuckCount >= 1) {
          logger.warn('[AgentRunner] Stuck: no progress after session — fast failing', {
            taskId: task.id, executionId: task.executionId,
            session: sessionCount, stuckCount,
            currentStep: latest?.currentStep || 'unknown',
          });
          const failureLog = [
            `## Session ${sessionCount} Stuck`,
            `### Progress: ${JSON.stringify(latest, null, 2)}`,
            `### Stuck count: ${stuckCount}`,
            `### Current step: ${latest?.currentStep || 'unknown'}`,
          ].join('\n');
          logger.info('[AgentRunner] Session token summary', {
            executionId: task.executionId,
            sessionId: sessionId.slice(0, 8),
            sessionScope: 'per-execution',
            goalId,
            totalInputTokens: cumulativeInputTokens,
            cacheReadTokens: cumulativeCacheHitTokens,
            cacheCreationTokens: cumulativeCacheCreationTokens,
            cacheHitRate: cumulativeInputTokens > 0
              ? Math.round(cumulativeCacheHitTokens / cumulativeInputTokens * 100) : 0,
            outputTokens: cumulativeOutputTokens,
            sessionCount,
            durationMs: cumulativeSessionMs,
            perSessionBreakdown,
          });
          return {
            success: false, worktree, outputFiles: [],
            error: `Max sessions (${config.maxSessions}) exhausted without completion`,
            failureLog,
            logFile, sessionCount, totalDurationMs: cumulativeSessionMs,
          };
        }
      }

      if (sessionCount >= config.maxSessions) {
        const failureLog = [
          `## Session ${sessionCount} Incomplete`,
          `### Progress: ${JSON.stringify(latest, null, 2)}`,
          `### Stuck count: ${stuckCount}`,
          `### Current step: ${latest?.currentStep || 'unknown'}`,
        ].join('\n');
        logger.info('[AgentRunner] Session token summary', {
          executionId: task.executionId,
          sessionId: sessionId.slice(0, 8),
          sessionScope: 'per-execution',
          goalId,
          totalInputTokens: cumulativeInputTokens,
          cacheReadTokens: cumulativeCacheHitTokens,
          cacheCreationTokens: cumulativeCacheCreationTokens,
          cacheHitRate: cumulativeInputTokens > 0
            ? Math.round(cumulativeCacheHitTokens / cumulativeInputTokens * 100) : 0,
          outputTokens: cumulativeOutputTokens,
          sessionCount,
          durationMs: cumulativeSessionMs,
          perSessionBreakdown,
        });
        return {
          success: false, worktree, outputFiles: [],
          error: `Max sessions (${config.maxSessions}) exhausted without completion`,
          failureLog,
          logFile, sessionCount, totalDurationMs: cumulativeSessionMs,
        };
      }

      logger.info('[AgentRunner] Session incomplete, re-spawning', {
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
    runningProcesses.delete(task.executionId);
  }

  return { success: false, worktree, outputFiles: [], error: 'Unreachable', logFile, sessionCount: 0 };
}
