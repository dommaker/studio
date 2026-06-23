/**
 * Agent Runner — unified executor merging AgentExecutor + TaskExecutor
 *
 * Key differences from AgentExecutor (session-manager.ts):
 *   - Uses `--output-format stream-json` (line-by-line JSON events)
 *   - Parses stdout for tool_use blocks, emits tool:call + file:change StudioEvents
 *   - Workspace fallback: task.parameters.workspaceRoot → DB query → createWorktree()
 *   - Stuck detection with strategy hints injection
 */

import type { ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import { logger, getModelForTier, buildSpawnEnv, parseStreamEvents, extractToolCalls, extractFilePath as extractFilePathShared, extractResult, extractUsage, type StreamEvent, type ModelTier, readSddDoc, findSddDocByGoalId, parseTaskDocContractTests, parseTaskDocTestFiles } from '@dommaker/studio-shared';
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
  emitToolCall,
  emitFileChange,
  recordExecutionError,
  getConstraintMeta,
  type ProgressReport,
} from './output-capture.js';

// ─── Re-use types from session-manager ───

export type { ExecutorConfig, AgentTask, ExecutionResult, PrerequisiteCheck } from './session-manager.js';

import type { ExecutorConfig, AgentTask, ExecutionResult, PrerequisiteCheck } from './session-manager.js';

// ─── Stream-json output event ───

/** @deprecated Use StreamEvent from @dommaker/studio-shared */
export type OutputEvent = StreamEvent;

// ─── Strategy hints (unicode-escaped to avoid linter issues) ───

const STRATEGY_HINTS: Record<number, string> = {
  0: '',
  1: '\u26a0\ufe0f \u4e0a\u6b21 session \u505c\u5728\u540c\u4e00\u4e2a\u6b65\u9aa4\u65e0\u8fdb\u5c55\u3002\u4e0d\u8981\u91cd\u590d\u76f8\u540c\u7684\u5c1d\u8bd5\u3002\u6362\u4e00\u79cd\u5b9e\u73b0\u601d\u8def\uff0c\u5148\u89e3\u91ca\u4f60\u6253\u7b97\u5c1d\u8bd5\u7684\u65b0\u65b9\u6cd5\uff082-3 \u53e5\uff09\uff0c\u518d\u52a8\u624b\u3002',
  2: '\u26a0\ufe0f\u26a0\ufe0f \u5df2\u7ecf\u8fde\u7eed 2 \u6b21\u5361\u5728\u540c\u4e00\u5904\u3002\u7f29\u5c0f\u8303\u56f4\uff1a\u53ea\u505a\u5f53\u524d\u6b65\u9aa4\u6700\u6838\u5fc3\u7684\u90e8\u5206\uff0c\u8df3\u8fc7\u8fb9\u7f18\u60c5\u51b5\u3002\u5199\u5b8c\u6700\u5c0f\u5b9e\u73b0\u540e\u7acb\u5373\u8dd1\u6d4b\u8bd5\u9a8c\u8bc1\u3002',
  3: '\u26a0\ufe0f\u26a0\ufe0f\u26a0\ufe0f \u4e25\u91cd\u963b\u585e \u2014 \u8fde\u7eed 3 \u6b21\u65e0\u8fdb\u5c55\u3002\u5f3a\u5236\u5207\u6362\u6a21\u5f0f\uff1a1) \u5148\u4e0d\u8981\u5199\u4ee3\u7801\uff0c\u8bfb REQUIREMENTS.md \u548c\u73b0\u6709\u4ee3\u7801\uff1b2) \u5199\u51fa 3 \u6b65\u4ee5\u5185\u7684 mini plan\uff1b3) \u53ea\u5b9e\u73b0\u7b2c 1 \u6b65\uff0c\u8dd1\u6d4b\u8bd5\uff1b4) \u8dd1\u901a\u540e\u518d\u7ee7\u7eed',
  4: '\ud83d\udd34 \u6700\u540e\u4e00\u6b21\u673a\u4f1a \u2014 \u653e\u5f03\u5f53\u524d\u65b9\u5411\uff0c\u4ece\u7b2c 0 \u884c\u91cd\u65b0\u5f00\u59cb\uff0c\u7528\u6700\u7b80\u5355\u3001\u6700\u6734\u7d20\u7684\u65b9\u5f0f\u5b9e\u73b0\uff08\u54ea\u6015\u4ee3\u7801\u4e11\uff09\uff0c\u5148\u8ba9\u6d4b\u8bd5\u901a\u8fc7\u3002',
};

const TIER_TIMEOUTS: Record<ModelTier, number> = { fast: 15, standard: 30, premium: 45 };
const TIER_MAX_TURNS: Record<ModelTier, number> = { fast: 8, standard: 15, premium: 25 };

/** Returns session timeout in minutes based on model tier. Unknown/missing tier → 30min default. */
export function getSessionTimeout(tier?: string): number {
  if (tier && tier in TIER_TIMEOUTS) return TIER_TIMEOUTS[tier as ModelTier];
  return 30;
}

const DEFAULT_MAX_SESSIONS = 5;

/** Files excluded from mtime check (agent writes these regardless of real progress) */
const MTIME_EXCLUDED_FILES = new Set(['.progress.json', '.agent.log']);

/**
 * Check if any file in the worktree was modified within the threshold.
 * Used to defer stuck detection during I/O waits (npm install, tsc, vitest).
 *
 * Scans top-level files + src/ directory (recursive). Excludes node_modules,
 * .progress.json, .agent.log, and all dot-prefixed entries.
 * Caps at 200 stat calls to keep check under 100ms.
 */
export function hasRecentActivity(worktreePath: string, thresholdMs = 3 * 60 * 1000): boolean {
  const cutoff = Date.now() - thresholdMs;
  let statCalls = 0;
  const MAX_STATS = 200;

  if (!fsSync.existsSync(worktreePath)) {
    return false;
  }

  let entries: fsSync.Dirent[];
  try {
    entries = fsSync.readdirSync(worktreePath, { withFileTypes: true });
  } catch {
    return false;
  }

  /** Check a single file's mtime. Returns true if recent. */
  function isRecent(filePath: string): boolean {
    if (statCalls >= MAX_STATS) return false;
    statCalls++;
    try {
      return fsSync.statSync(filePath).mtimeMs > cutoff;
    } catch {
      return false;
    }
  }

  /** Recursively check directory entries (skips excluded dirs). */
  function checkDir(dirPath: string): boolean {
    if (statCalls >= MAX_STATS) return false;
    let dirEntries: fsSync.Dirent[];
    try {
      dirEntries = fsSync.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of dirEntries) {
      if (statCalls >= MAX_STATS) return false;
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isFile()) {
        if (isRecent(fullPath)) return true;
      } else if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        if (checkDir(fullPath)) return true;
      }
    }
    return false;
  }

  for (const entry of entries) {
    if (statCalls >= MAX_STATS) break;
    const name = entry.name;

    // Skip excluded: dotfiles, node_modules
    if (name.startsWith('.') || name === 'node_modules') continue;

    const fullPath = path.join(worktreePath, name);

    if (entry.isFile() && !MTIME_EXCLUDED_FILES.has(name)) {
      if (isRecent(fullPath)) return true;
    }

    // Recurse into src/
    if (entry.isDirectory() && name === 'src') {
      if (checkDir(fullPath)) return true;
    }
  }

  return false;
}

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
  // Execute (session loop)
  // ========================================

  async execute(task: AgentTask): Promise<ExecutionResult> {
    logger.info('[AgentRunner] Starting session loop', { taskId: task.id, executionId: task.executionId });

    let worktree: string;
    try {
      worktree = await this.resolveWorktree(task);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const fallbackLog = path.join(this.config.worktreesDir, task.executionId, '.agent.log');
      return { success: false, worktree: '', outputFiles: [], error: errorMessage, logFile: fallbackLog, sessionCount: 0 };
    }

    // Derive logFile from resolved worktree path (not config.worktreesDir)
    const logFile = path.join(worktree, '.agent.log');

    try {
      // Step 1: prerequisite checks
      const checks = await this.checkPrerequisites();
      const errors = checks.filter(c => !c.passed && !c.isWarning);
      if (errors.length > 0) {
        throw new Error(`\u524d\u7f6e\u68c0\u67e5\u5931\u8d25: ${errors.map(e => e.message).join(', ')}`);
      }

      // Step 2: propagate harness config
      await propagateHarnessConfig(worktree, task.id, task.executionId, this.config.repoDir);

      // Step 2.5: pre-populate node_modules (dependency cache)
      await ensureDeps(worktree, this.config.repoDir);

      // Write cache prefix
      try {
        const prefixPath = path.join(worktree, 'CACHE_PREFIX.md');
        if (!fsSync.existsSync(prefixPath)) {
          const shared = buildCachePrefix(this.config.repoDir);
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
      const sddTaskData = this.resolveSddTaskData(task);
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
      const execSessionDir = path.join(this.config.worktreesDir, '.execution-sessions', task.executionId);
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

      while (sessionCount < this.config.maxSessions) {
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
        const prompt = this.buildPrompt(task, progress, sessionCount, acGroup, stuckCount, knowledgeContext, resolutionHint);
        fsSync.mkdirSync(worktree, { recursive: true });
        await fs.writeFile(path.join(worktree, '.prompt.md'), prompt, 'utf-8');

        // Session flags
        const isFirstSession = sessionCount === 1;
        const sessionFlag = isFirstSession
          ? (isNewSession
              ? `--session-id ${sessionId} --name "executor-${task.executionId.slice(0, 8)}"`
              : '--continue')
          : '--continue';

        const taskTier = (task.model as ModelTier) || 'standard';
        const model = getModelForTier(taskTier);

        // Write prompt file
        const promptFile = path.join(worktree, '.daemon', 'prompt.md');
        fsSync.mkdirSync(path.dirname(promptFile), { recursive: true });
        fsSync.writeFileSync(promptFile, prompt, 'utf-8');

        // Restrict tool access
        const _analystCtx = (task.parameters?.analystContext as any) || null;
        const _restrictDirs = _analystCtx?.verifiedFiles as string[] | undefined;
        const addDirArgs = _restrictDirs?.length
          ? _restrictDirs.map((f: string) => {
              const dir = f.split('/').slice(0, -1).join('/');
              return `--add-dir "${dir}"`;
            }).join(' ')
          : '';

        // AC1.1: Use stream-json output format
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

        logger.info('[AgentRunner] Spawning session', {
          taskId: task.id,
          executionId: task.executionId,
          session: sessionCount,
          isFirstSession,
          isNewSession,
          model,
        });

        const childRef: { current: ChildProcess | null } = { current: null };
        this.runningProcesses.set(task.executionId, childRef);

        const sessionStart = Date.now();
        collectedSessionIds.push(sessionId);

        await emitSessionStart(sessionId, task.executionId, sessionCount);

        try {
          const { stdout } = await execSh(cmd, {
            cwd: worktree,
            env: {
              ...process.env,
              ...buildSpawnEnv({
                tier: taskTier,
                role: 'executor',
                extra: {
                  STUDIO_EXECUTION_ID: task.executionId,
                  ...(task.parameters?.goalId ? { STUDIO_GOAL_ID: task.parameters.goalId as string } : {}),
                },
              }),
              // HOME isolation: prevent user-level settings.json env override
              HOME: `/tmp/execution-${task.executionId}`,
            },
            timeoutMs: task.timeoutMs ?? getSessionTimeout(taskTier) * 60 * 1000,
            maxBuffer: 10 * 1024 * 1024,
            childRef,
          });

          fsSync.writeFileSync(logFile, stdout, 'utf-8');

          // AC1.1 + AC1.3: Parse stream-json line by line
          const events = this.parseStreamOutput(stdout);
          const { text, isError } = this.extractResult(events);
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
            modelTier: (task.model as string) || 'standard',
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
              resolutionHint = '## \u5df2\u77e5\u89e3\u6cd5 (RKB)\n\u4ee5\u4e0b\u89e3\u6cd5\u66fe\u5728\u7c7b\u4f3c\u9519\u8bef\u4e0a\u9a8c\u8bc1\u6709\u6548\uff1a\n' + matched.join('\n');
            }
          } catch { /* non-blocking */ }

          if (sessionCount >= this.config.maxSessions) {
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
              model: (task.model as string) || 'standard',
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
              error: `Max sessions (${this.config.maxSessions}) exhausted. Last error: ${detail}`,
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
            model: (task.model as string) || 'standard',
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
              model: (task.model as string) || 'standard',
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
              error: `Max sessions (${this.config.maxSessions}) exhausted without completion`,
              failureLog,
              logFile, sessionCount, totalDurationMs: cumulativeSessionMs,
            };
          }
        }

        if (sessionCount >= this.config.maxSessions) {
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
            model: (task.model as string) || 'standard',
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
            error: `Max sessions (${this.config.maxSessions}) exhausted without completion`,
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
      this.runningProcesses.delete(task.executionId);
    }

    return { success: false, worktree, outputFiles: [], error: 'Unreachable', logFile, sessionCount: 0 };
  }

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
   * Session flags (session-id/continue) come from task.parameters.sessionFlags.
   */
  async executeLightweight(task: AgentTask): Promise<ExecutionResult> {
    logger.info('[AgentRunner] Lightweight execution', { taskId: task.id, executionId: task.executionId });

    let worktree: string;
    try {
      worktree = await this.resolveWorktree(task);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, worktree: '', outputFiles: [], error: errorMessage, logFile: '', sessionCount: 0 };
    }

    const logFile = path.join(worktree, '.agent.log');

    try {
      // Prerequisite checks (keep — fast validation)
      const checks = await this.checkPrerequisites();
      const errors = checks.filter(c => !c.passed && !c.isWarning);
      if (errors.length > 0) {
        throw new Error(`前置检查失败: ${errors.map(e => e.message).join(', ')}`);
      }

      // Propagate harness config (keep — gives daemon access to harness rules)
      await propagateHarnessConfig(worktree, task.id, task.executionId, this.config.repoDir);

      // Write prompt
      const promptFile = path.join(worktree, '.daemon', 'prompt.md');
      fsSync.mkdirSync(path.dirname(promptFile), { recursive: true });
      fsSync.writeFileSync(promptFile, task.prompt, 'utf-8');

      // Session management — caller provides flags via parameters
      const sessionFlags = (task.parameters?.sessionFlags as string) || '';
      const taskTier = (task.model as ModelTier) || 'standard';
      const model = getModelForTier(taskTier);
      const agentRole = (task.parameters?.agentRole as string) || 'executor';
      const sessionId = task.executionId;

      const cmd = [
        `cd "${worktree}"`,
        `&&`,
        `claude`,
        `--print`,
        `--output-format stream-json`,
        `--verbose`,
        `--max-turns ${TIER_MAX_TURNS[taskTier as ModelTier] || 15}`,
        sessionFlags,
        `<`,
        `"${promptFile}"`,
        `2>&1`,
      ].filter(Boolean).join(' ');

      logger.info('[AgentRunner] Lightweight session spawning', {
        taskId: task.id, executionId: task.executionId, model, sessionFlags,
      });

      const childRef: { current: ChildProcess | null } = { current: null };
      this.runningProcesses.set(task.executionId, childRef);

      const sessionStart = Date.now();
      await emitSessionStart(sessionId, task.executionId, 1);

      try {
        const { stdout } = await execSh(cmd, {
          cwd: worktree,
          env: {
            ...process.env,
            ...buildSpawnEnv({
              tier: taskTier,
              role: agentRole as 'analyst' | 'executor',
              extra: {
                STUDIO_EXECUTION_ID: task.executionId,
                ...(task.parameters?.goalId ? { STUDIO_GOAL_ID: task.parameters.goalId as string } : {}),
                ...(task.parameters?.extraEnv as Record<string, string> || {}),
              },
            }),
            // HOME isolation: prevent user-level settings.json env block
            // from overriding pipeline config (DeepSeek API keys/models).
            // Claude Code CLI reads $HOME/.claude/settings.json on startup.
            // Project-level settings (permissions/hooks) use absolute paths, unaffected.
            HOME: `/tmp/execution-${task.executionId}`,
          },
          timeoutMs: task.timeoutMs ?? getSessionTimeout(taskTier) * 60 * 1000,
          maxBuffer: 10 * 1024 * 1024,
          childRef,
        });

        fsSync.writeFileSync(logFile, stdout, 'utf-8');

        const events = this.parseStreamOutput(stdout);
        const { text, isError } = this.extractResult(events);

        // Emit tool:call + file:change events
        const tools = extractToolCalls(events);
        for (const tool of tools) {
          await emitToolCall(tool.name, tool.input, sessionId, task.executionId);
          const filePath = extractFilePathShared(tool.name, tool.input);
          if (filePath) {
            await emitFileChange(filePath, sessionId, task.executionId);
          }
        }

        // Record session metrics
        const sessionMs = Date.now() - sessionStart;
        const streamUsage = extractUsage(events);
        const { hash: cHash, size: cSize } = await getConstraintMeta();
        await recordSessionMetrics({
          stdout,
          executionId: task.executionId,
          agentRole,
          modelTier: (task.model as string) || 'standard',
          sessionCount: 1,
          isFirstSession: true,
          sessionMs,
          promptSize: task.prompt.length,
          constraintHash: cHash,
          constraintSize: cSize,
          streamUsage,
        });

        await emitSessionEnd(sessionId, task.executionId, 1);

        if (isError) {
          logger.warn('[AgentRunner] Lightweight session returned error', {
            taskId: task.id, text: text.slice(0, 200),
          });
          return {
            success: false, worktree, outputFiles: [], error: text.slice(0, 500),
            logFile, sessionCount: 1, totalDurationMs: sessionMs, sessionIds: [sessionId],
          };
        }

        logger.info('[AgentRunner] Lightweight session completed', {
          taskId: task.id, executionId: task.executionId, sessionMs,
        });

        return {
          success: true, worktree, outputFiles: [], logFile,
          sessionCount: 1, totalDurationMs: sessionMs, sessionIds: [sessionId],
          outputText: text || undefined,
        };
      } catch (execErr: any) {
        const errMsg = execErr instanceof Error ? execErr.message : String(execErr);
        const stdoutText = execErr?.stdout?.toString().slice(0, 2000) || '';
        const stderrText = execErr?.stderr?.toString().slice(0, 500) || '';

        await recordExecutionError({
          executionId: task.executionId, errMsg, errStack: execErr?.stack?.slice(0, 2000),
          stderrText, stdoutText, sessionCount: 1, cumulativeSessionMs: Date.now() - sessionStart,
          signal: execErr?.signal, code: execErr?.code,
        });

        await emitSessionEnd(sessionId, task.executionId, 1);

        return {
          success: false, worktree, outputFiles: [],
          error: errMsg.slice(0, 500),
          failureLog: stdoutText ? stdoutText.slice(-1000) : undefined,
          logFile, sessionCount: 1, totalDurationMs: Date.now() - sessionStart,
          sessionIds: [sessionId],
        };
      } finally {
        this.runningProcesses.delete(task.executionId);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, worktree, outputFiles: [], error: errorMessage, logFile, sessionCount: 0 };
    }
  }

  // ========================================
  // SP-004 Step 5: SDD task layer resolution
  // ========================================

  /**
   * Resolve contractTests + testFiles from SDD task layer.
   * Tries `docs/sdd/<slug>/task.md` first, falls back to DB values in task.parameters.
   *
   * SDD task.md format:
   *   ## Contract Tests
   *   ### <file-path>
   *   ```typescript ... ```
   *   ## Test Files
   *   - <path>
   */
  private resolveSddTaskData(task: AgentTask): {
    contractTests: Array<{ file: string; content: string }> | undefined;
    testFiles: string[];
  } {
    // DB fallback values
    const dbContractTests = task.parameters?.contractTests as Array<{ file: string; content: string }> | undefined;
    const dbTestFiles: string[] = [];

    // Resolve slug
    const slug = (task.parameters?.sddSlug as string)
      || findSddDocByGoalId((task.parameters?.goalId as string) || '');

    if (!slug) {
      return { contractTests: dbContractTests, testFiles: dbTestFiles };
    }

    try {
      const taskDoc = readSddDoc(slug, 'task');
      if (!taskDoc) {
        return { contractTests: dbContractTests, testFiles: dbTestFiles };
      }

      const sddContractTests = parseTaskDocContractTests(taskDoc.body);
      const sddTestFiles = parseTaskDocTestFiles(taskDoc.body);

      const contractTests = sddContractTests.length > 0 ? sddContractTests : dbContractTests;
      const testFiles = sddTestFiles.length > 0 ? sddTestFiles : dbTestFiles;

      logger.info('[AgentRunner] SDD task layer resolved', {
        slug,
        contractTestsSource: sddContractTests.length > 0 ? 'sdd' : 'db',
        contractTestsCount: contractTests?.length || 0,
        testFilesSource: sddTestFiles.length > 0 ? 'sdd' : 'db',
        testFilesCount: testFiles.length,
      });

      return { contractTests, testFiles };
    } catch (err) {
      logger.warn('[AgentRunner] SDD task layer read failed, falling back to DB', {
        slug,
        error: String(err),
      });
      return { contractTests: dbContractTests, testFiles: dbTestFiles };
    }
  }

  // ========================================
  // Prerequisites
  // ========================================

  async checkPrerequisites(): Promise<PrerequisiteCheck[]> {
    const checks: PrerequisiteCheck[] = [];
    logger.info('[AgentRunner] Checking prerequisites', { repoDir: this.config.repoDir });

    try {
      const { stdout } = await execSh('claude --version 2>&1 || echo "NOT_FOUND"', {
        cwd: '/tmp',
        timeoutMs: 10_000,
      });
      if (stdout.includes('NOT_FOUND')) {
        checks.push({ name: 'Claude Code CLI', passed: false, message: 'claude \u547d\u4ee4\u4e0d\u53ef\u7528' });
      } else {
        checks.push({ name: 'Claude Code CLI', passed: true, message: stdout.trim().slice(0, 80) });
      }
    } catch {
      checks.push({ name: 'Claude Code CLI', passed: false, message: 'claude \u547d\u4ee4\u4e0d\u53ef\u7528' });
    }

    try {
      const { stdout } = await execSh('df -h . | tail -1 | awk "{print \$4}"', {
        cwd: this.config.worktreesDir,
        timeoutMs: 5_000,
      });
      const cleaned = stdout.trim().replace(/[^0-9.]/g, '');
      const availableGB = parseInt(cleaned, 10);
      if (isNaN(availableGB)) {
        checks.push({ name: '\u78c1\u76d8\u7a7a\u95f4', passed: true, message: `\u65e0\u6cd5\u89e3\u6790: "${stdout.trim()}"`, isWarning: true });
      } else {
        checks.push({
          name: '\u78c1\u76d8\u7a7a\u95f4', passed: availableGB >= 5,
          message: `\u78c1\u76d8\u7a7a\u95f4: ${availableGB}GB`,
          isWarning: availableGB < 5 && availableGB >= 2,
        });
      }
    } catch {
      checks.push({ name: '\u78c1\u76d8\u7a7a\u95f4', passed: true, message: '\u65e0\u6cd5\u68c0\u6d4b', isWarning: true });
    }

    try {
      await fs.mkdir(this.config.worktreesDir, { recursive: true });
      checks.push({ name: 'worktrees \u76ee\u5f55', passed: true, message: `\u76ee\u5f55\u53ef\u5199: ${this.config.worktreesDir}` });
    } catch {
      checks.push({ name: 'worktrees \u76ee\u5f55', passed: false, message: `\u76ee\u5f55\u4e0d\u53ef\u5199: ${this.config.worktreesDir}` });
    }

    try {
      await execSh('git rev-parse --git-dir', {
        cwd: this.config.repoDir,
        timeoutMs: 5_000,
      });
      checks.push({ name: 'Git Repo', passed: true, message: `\u4e3b\u4ed3\u5e93: ${this.config.repoDir}` });
    } catch {
      checks.push({ name: 'Git Repo', passed: false, message: `${this.config.repoDir} \u4e0d\u662f git \u4ed3\u5e93` });
    }

    return checks;
  }

  // ========================================
  // Prompt building
  // ========================================

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
    const constraintPrompt = buildAgentConstraintPrompt({
      operation: 'code_implementation',
      taskDescription: task.prompt,
    });

    const rawConstraints = task.parameters?.roleConstraints;
    const roleConstraints: string[] = Array.isArray(rawConstraints) ? rawConstraints
      : typeof rawConstraints === 'string' ? JSON.parse(rawConstraints)
      : [];
    const roleConstraintSection = roleConstraints.length
      ? `\n## \u89d2\u8272\u7ea6\u675f\n\u4ee5\u4e0b\u7ea6\u675f\u4f18\u5148\u4e8e\u4e00\u822c\u6307\u5bfc\u539f\u5219\uff1a\n${roleConstraints.map((c: string) => `- ${c}`).join('\n')}\n`
      : '';

    const knowledgeSection = knowledgeContext
      ? `\n## \u9879\u76ee\u4e0a\u4e0b\u6587\n${knowledgeContext}\n`
      : '';

    const constraintSection = constraintPrompt || roleConstraintSection || knowledgeSection
      ? (constraintPrompt + roleConstraintSection + knowledgeSection + '\n---\n\n')
      : '';

    const OUTPUT_STYLE_MAP: Record<string, string> = {
      analyst: 'Output style: Be concise. Drop filler words (just, really, basically). No sycophantic openers or closing fluff. Keep complete sentences. Technical terms exact.',
      executor: 'Output style: Terse like caveman. Drop articles (a/an/the), filler words, pleasantries, hedging. Fragments OK. Short synonyms. Code blocks unchanged. Technical substance exact.',
      reviewer: 'Output style: Terse like caveman. Drop articles (a/an/the), filler words, pleasantries, hedging. Fragments OK. Short synonyms. Code blocks unchanged. Technical substance exact.',
      integration: 'Output style: Ultra-terse. Maximum compression. Telegraphic style. Drop all non-essential words. Code output only \u2014 no explanation unless error.',
      deploy: 'Output style: Be concise. Drop filler words. No fluff. Keep complete sentences. Technical terms exact.',
    };
    const outputStyleSection = `## \u8f93\u51fa\u98ce\u683c\n${OUTPUT_STYLE_MAP[role] || OUTPUT_STYLE_MAP.executor}\n\n`;

    const skillTier = (task.model as SkillTier) || 'standard';
    const skillsToInject = skillLoader.load({ agentType: 'executor', tier: skillTier });
    const skillPrompt = skillLoader.formatForPrompt(skillsToInject);

    if (session === 1 || !progress) {
      const analystContext = (task.parameters?.analystContext as any) || null;
      const analystContextSection = analystContext ? [
        '## \u5df2\u6709\u5206\u6790\u4e0a\u4e0b\u6587\uff08\u6765\u81ea Analyst \u63a2\u7d22\uff09',
        '',
        `**\u5df2\u9a8c\u8bc1\u6587\u4ef6** (\u4e0d\u9700\u8981\u91cd\u65b0\u63a2\u7d22): ${(analystContext.verifiedFiles || []).join(', ')}`,
        analystContext.architectureContext ? `\n**\u67b6\u6784\u8bf4\u660e**: ${analystContext.architectureContext}` : '',
        analystContext.gotchas?.length ? `\n**\u6ce8\u610f\u4e8b\u9879**: ${analystContext.gotchas.join('; ')}` : '',
        '',
        '\u53ea\u4fee\u6539\u4e0a\u8ff0\u6587\u4ef6\u3002\u5982\u9700\u67e5\u770b\u989d\u5916\u6587\u4ef6\uff0c\u8bf4\u660e\u539f\u56e0\u2014\u2014Scheduler \u5c06\u6dfb\u52a0\u6743\u9650\u540e\u7ee7\u7eed\u3002',
        '',
      ].join('\n') : '';

      const verifyStep = acGroup?.architectureContext
        ? '\n\u26a0\ufe0f REQUIREMENTS.md \u5305\u542b\u67b6\u6784\u4e0a\u4e0b\u6587\uff08Analyst \u5df2\u63a2\u7d22\u7684\u4ee3\u7801\u4f4d\u7f6e\u548c\u7b7e\u540d\uff09\u3002\n\u7b2c\u4e00\u6b65\u5fc5\u987b\u662f\u9a8c\u8bc1\u5173\u952e\u51fd\u6570\u7b7e\u540d\u548c\u884c\u53f7\u662f\u5426\u4ecd\u7136\u6709\u6548\uff0c\u5982\u679c\u5df2\u504f\u79fb\u8bf7\u4fee\u6b63\u540e\u518d\u5b9e\u73b0\u3002\n'
        : '';
      const base = `${constraintSection}${outputStyleSection}${analystContextSection}## \u4f60\u7684\u4efb\u52a1
${task.prompt}


\u8bfb REQUIREMENTS.md \u4e86\u89e3\u4f60\u8981\u5b8c\u6210\u7684\u4efb\u52a1\u548c\u9a8c\u6536\u6807\u51c6\u3002${verifyStep}
${skillPrompt}`;
      return resolutionHint ? `${base}\n\n${resolutionHint}` : base;
    }

    // Session 2+: continuation prompt
    const hintLevel = Math.min(stuckCount, 4);
    const strategyHint = STRATEGY_HINTS[hintLevel];
    const parts = [
      `${constraintSection}${outputStyleSection}## \u7eed\u63a5\u4efb\u52a1`,
      '',
      '\u8bfb REQUIREMENTS.md \u4e86\u89e3\u4efb\u52a1\u3002',
      '\u8bfb .progress.json \u4e86\u89e3\u8fdb\u5ea6\u3002',
      '',
      `\u4f60\u4e0a\u6b21\u505a\u5230\uff1a${progress.currentStep || '\u672a\u77e5'}`,
      `\u5df2\u5b8c\u6210\uff1a${progress.completedSteps?.join(', ') || '\u65e0'}`,
      `\u6d4b\u8bd5\u7ed3\u679c\uff1a${progress.testResults?.passed || 0} passed / ${progress.testResults?.failed || 0} failed`,
      `\u5907\u6ce8\uff1a${progress.notes || '\u65e0'}`,
    ];
    if (skillPrompt) parts.push('', skillPrompt);
    if (strategyHint) parts.push('', strategyHint);
    if (resolutionHint) parts.push('', resolutionHint);
    parts.push('', '\u7ee7\u7eed\u5de5\u4f5c\uff0c\u4ece\u4e0a\u6b21\u4e2d\u65ad\u7684\u5730\u65b9\u5f00\u59cb\u3002\u6bcf\u5b8c\u6210\u4e00\u6b65\u540e\u66f4\u65b0 .progress.json\u3002');
    parts.push('\u5168\u90e8\u5b8c\u6210\u540e\u8bbe\u7f6e allComplete: true\u3002');
    return parts.join('\n');
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
