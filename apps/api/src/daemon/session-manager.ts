// Session Manager — manages persistent Claude Code sessions via --session-id + --continue
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger, getModelForTier } from '@dommaker/studio-shared';
import { execSh, resolveSessionId, readSessionIdFile } from '@dommaker/studio-shared/node';
import type { ModelTier } from '@dommaker/studio-shared';
import { parseClaudeUsage, recordPipelineRun } from './metrics.js';
import { writeTaskLog, classifyTaskError } from './task-logger.js';
import type { TaskLog } from './task-logger.js';

export interface SessionConfig {
  name: string;
  worktree: string;
  modelTier: ModelTier;
  timeoutMs: number;
  persistent: boolean;
}

export interface JobSpec {
  prompt: string;
  outputFile: string;
  env?: Record<string, string>;
  claudeArgs?: string[]; // O1d: extra CLI args passed to claude command
}

export interface TaskResult {
  success: boolean;
  output?: string;
  error?: string;
  sessionId: string;
  durationMs: number;
}

interface SessionState {
  config: SessionConfig;
  sessionId: string;          // UUID, persisted to worktree for --session-id
  isBusy: boolean;
  lastUsed: number;
  taskCount: number;
  isNewSession: boolean;      // true = 刚生成 UUID，需 --session-id；false = 从文件加载，用 --continue
}

export class SessionManager {
  private sessions = new Map<string, SessionState>();
  // M6: session cache hit/miss tracking
  private cacheHits = 0;
  private cacheMisses = 0;

  register(config: SessionConfig): void {
    this.ensureWorktree(config);

    const daemonDir = path.join(config.worktree, '.daemon');
    if (!fs.existsSync(daemonDir)) fs.mkdirSync(daemonDir, { recursive: true });
    const sidFile = path.join(daemonDir, 'session-id');
    const pidFile = path.join(daemonDir, 'daemon-pid');

    // 读上次 daemon 的 PID — 如果进程还活着，说明 daemon 没重启，session 可复用
    let previousPid = 0;
    try { previousPid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10); } catch {}
    const daemonAlive = previousPid > 0 && this.isProcessAlive(previousPid);

    let sessionId: string;
    let isNewSession: boolean;

    if (daemonAlive) {
      const existingId = readSessionIdFile(config.worktree);
      if (existingId) {
        sessionId = existingId;
        isNewSession = false; // daemon 没重启 → session 仍有效 → --continue 复用
      } else {
        sessionId = crypto.randomUUID();
        isNewSession = true;
      }
    } else {
      // daemon 重启了（或首次启动）→ 旧 session 已死 → 生成新 UUID
      try { fs.unlinkSync(sidFile); } catch {}
      sessionId = crypto.randomUUID();
      isNewSession = true;
      fs.writeFileSync(sidFile, sessionId, 'utf-8');
      if (previousPid > 0) {
        logger.info('[SessionManager] Previous daemon dead — new session', {
          name: config.name, previousPid,
        });
      }
    }

    // 写当前 PID 供下次启动判断
    fs.writeFileSync(pidFile, String(process.pid), 'utf-8');

    this.sessions.set(config.name, {
      config,
      sessionId,
      isBusy: false,
      lastUsed: 0,
      taskCount: 0,
      isNewSession,
    });
    logger.info('[SessionManager] Registered session', {
      name: config.name,
      sessionId,
      worktree: config.worktree,
      persistent: config.persistent,
      daemonAlive,
    });
  }

  /** Ad-hoc session: 注册一个临时 session，不持久化，用于并发任务。 */
  registerAdhoc(config: SessionConfig): void {
    const sessionId = crypto.randomUUID();
    // Ensure .claude/settings.json with bypassPermissions for root daemon
    const claudeDir = path.join(config.worktree, '.claude');
    const settingsPath = path.join(claudeDir, 'settings.json');
    if (!fs.existsSync(settingsPath)) {
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify({
        permissions: { defaultMode: 'bypassPermissions' },
      }, null, 2), 'utf-8');
    }
    this.sessions.set(config.name, {
      config,
      sessionId,
      isBusy: false,
      lastUsed: 0,
      taskCount: 0,
      isNewSession: true,
    });
    logger.info('[SessionManager] Registered ad-hoc session', {
      name: config.name,
      sessionId: sessionId.slice(0, 8),
    });
  }

  /** 从 sessions map 中移除 */
  unregister(name: string): void {
    this.sessions.delete(name);
  }

  /** 检查进程是否存活 (kill(pid, 0) = 信号探测，不杀进程) */
  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async runTask(sessionName: string, job: JobSpec): Promise<TaskResult> {
    const state = this.sessions.get(sessionName);
    if (!state) throw new Error(`Session not found: ${sessionName}`);

    // Concurrency guard — now meaningful with async spawn
    if (state.isBusy) throw new Error(`Session ${sessionName} is busy`);
    state.isBusy = true;

    const startTime = Date.now();
    const daemonDir = path.join(state.config.worktree, '.daemon');
    fs.mkdirSync(daemonDir, { recursive: true });

    const promptFile = path.join(daemonDir, 'prompt.md');
    fs.writeFileSync(promptFile, job.prompt, 'utf-8');

    const isFirstTask = state.taskCount === 0;
    const model = getModelForTier(state.config.modelTier);
    const phase = sessionName === 'analyst' ? 'analyst' : 'executor';

    // Build base log entry (taskIndex 在 taskCount++ 前捕获，避免偏1)
    const taskIndex = state.taskCount + 1;
    const buildLog = (overrides: Partial<TaskLog>): TaskLog => ({
      timestamp: new Date().toISOString(),
      session: sessionName,
      sessionId: state.sessionId,
      taskIndex,
      model,
      phase,
      command: '',  // filled by caller
      durationMs: Date.now() - startTime,
      success: false,
      inputTokens: 0,
      outputTokens: 0,
      cacheHitTokens: 0,
      ...overrides,
    });

    try {
      // Build claude command
      // Brand-new session: --session-id <UUID> --name <name> creates it
      // Resumed (daemon restart): --continue resumes existing Claude session
      // Subsequent tasks in same session: --continue
      const sessionFlag = isFirstTask
        ? (state.isNewSession
            ? `--session-id ${state.sessionId} --name "${sessionName}"`
            : '--continue')
        : '--continue';
      // Use stdin file redirect instead of pipe — more reliable under Node spawn
      const stdinFile = promptFile; // written to disk at line 95
      // O1d: Inject extra claude args (e.g. --allowedTools restriction)
      const claudeFlags = job.claudeArgs || [];
      const cmd = [
        `cd "${state.config.worktree}"`,
        `&&`,
        `claude`,
        `--print`,
        `--output-format json`,
        sessionFlag,
        ...claudeFlags,
        `<`,
        `"${stdinFile}"`,
        `2>&1`,  // merge stderr → stdout — execSh captures stdout, downstream consumers need error output
      ].join(' ');

      logger.info('[SessionManager] Running task', {
        session: sessionName,
        task: state.taskCount + 1,
        isFirstTask,
        model,
        isNewSession: state.isNewSession,
        sessionFlag,
        sessionId: state.sessionId,
      });

      let stdout: string;
      try {
        const result = await execSh(cmd, {
          cwd: state.config.worktree,
          env: { ...process.env, ANTHROPIC_MODEL: model, ...job.env },
          timeoutMs: state.config.timeoutMs,
          maxBuffer: 10 * 1024 * 1024,
        });
        stdout = result.stdout;
      } catch (execErr) {
        const errMsg = execErr instanceof Error ? execErr.message : String(execErr);
        const stderr = (execErr as any)?.stderr?.toString() || '';
        const stdout_fail = (execErr as any)?.stdout?.toString() || '';
        const errCode = (execErr as any)?.code;

        const durationMs = Date.now() - startTime;
        const userMsg = stderr.slice(0, 300) || errMsg.slice(0, 300);
        logger.error('[SessionManager] Task failed', {
          session: sessionName,
          error: userMsg.slice(0, 200),
          exitCode: errCode,
          stdoutPreview: stdout_fail.slice(0, 200),
          stderrPreview: stderr.slice(0, 200),
        });

        // P0.3 fix: 第一次任务失败后删除 session-id 文件，避免下次重启时
        // 误用 --continue 续接已损坏的 session
        if (isFirstTask && state.isNewSession) {
          const sessionIdFile = path.join(state.config.worktree, '.daemon', 'session-id');
          try { fs.unlinkSync(sessionIdFile); } catch {}
          state.sessionId = crypto.randomUUID();
        }

        recordPipelineRun({
          source: 'pipeline', phase: sessionName === 'analyst' ? 'analyst' : 'executor',
          taskName: `daemon-${sessionName}-${state.taskCount + 1}`, model,
          inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, durationMs,
          success: false, error: userMsg, sessionId: state.sessionId,
        }).catch(e => logger.warn('[SessionManager] Metrics record failed', { error: String(e) }));

        writeTaskLog(buildLog({ command: cmd, success: false, errorType: classifyTaskError(errMsg + stderr), errorDetail: userMsg, stdoutPreview: '', stderrPreview: stderr.slice(0, 500), durationMs }));
        return { success: false, error: userMsg, sessionId: sessionName, durationMs };
      }

      const durationMs = Date.now() - startTime;
      state.lastUsed = Date.now();
      state.taskCount++;
      const wasNewSession = state.isNewSession;
      // After first successful task, session is established — future starts use --continue
      state.isNewSession = false;

      // Parse JSON envelope: { result, usage, is_error }
      let text = stdout;
      let isError = false;
      try {
        const envelope = JSON.parse(stdout);
        if (envelope.is_error) { isError = true; text = ''; }
        if (envelope.result) text = envelope.result;
      } catch (e) {
        logger.error('[SessionManager] Failed to parse JSON envelope', { error: String(e) });
      }

      if (isError) {
        logger.warn('[SessionManager] Claude Code returned error', { session: sessionName, text: text.slice(0, 200) });
        recordPipelineRun({
          source: 'pipeline', phase: sessionName === 'analyst' ? 'analyst' : 'executor',
          taskName: `daemon-${sessionName}-${state.taskCount}`, model,
          inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, durationMs,
          success: false, error: text.slice(0, 200), sessionId: state.sessionId,
        }).catch(e => logger.warn('[SessionManager] Metrics record failed'));
        writeTaskLog(buildLog({ command: cmd, success: false, errorType: 'llm_error', errorDetail: text.slice(0, 300), stdoutPreview: stdout.slice(0, 500), durationMs }));
        return { success: false, error: text.slice(0, 300), sessionId: sessionName, durationMs };
      }

      const usage = parseClaudeUsage(stdout);

      // Session 丢失检测：daemon 重启后用 --continue 续接，但 Claude session 已删除
      // --continue 会静默创建新 session（~25K input tokens），而不是复用旧 session（~200-500）
      // 此时更新 session-id 文件，确保下次 daemon 重启用 --session-id --name 建命名 session
      if (isFirstTask && !wasNewSession && usage.inputTokens > 10_000) {
        this.cacheMisses++;
        logger.warn('[SessionManager] Session cache lost — --continue created fresh session, regenerating session-id', {
          session: sessionName,
          oldSessionId: state.sessionId,
          inputTokens: usage.inputTokens,
          cacheHitRate: this.getCacheHitRate(),
        });
        state.sessionId = crypto.randomUUID();
        const sidFile = path.join(state.config.worktree, '.daemon', 'session-id');
        fs.writeFileSync(sidFile, state.sessionId, 'utf-8');
      } else if (isFirstTask && !wasNewSession) {
        this.cacheHits++;
      }

      // Read output file if specified
      let output: string | undefined;
      if (job.outputFile && fs.existsSync(job.outputFile)) {
        output = fs.readFileSync(job.outputFile, 'utf-8');
      } else {
        output = text || stdout;
      }
      // Extract turns from .agent.log for logging
      let numTurns = 0;
      let sessionCost = 0;
      try {
        const agentLogPath = path.join(state.config.worktree, '.agent.log');
        if (fs.existsSync(agentLogPath)) {
          const agentLog = JSON.parse(fs.readFileSync(agentLogPath, 'utf-8'));
          numTurns = agentLog.num_turns || 0;
          sessionCost = agentLog.total_cost_usd || 0;
        }
      } catch {}

      logger.info('[SessionManager] Task completed', {
        session: sessionName,
        task: state.taskCount,
        durationMs,
        turns: numTurns,
        outputLen: output?.length || 0,
        inputTokens: usage.inputTokens,
        cacheHitTokens: usage.cacheHitTokens,
        costUSD: Math.round(sessionCost * 1000) / 1000,
      });

      // B1-016: 记录管线指标
      recordPipelineRun({
        source: 'pipeline',
        phase: sessionName === 'analyst' ? 'analyst' : 'executor',
        taskName: `daemon-${sessionName}-${state.taskCount}`,
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheHitTokens: usage.cacheHitTokens,
        durationMs,
        success: true,
        sessionId: state.sessionId,
      }).catch(e => logger.warn('[SessionManager] Metrics record failed', { error: String(e) }));

      // 从 .agent.log 记录会话级缓存指标（num_turns, cache ratio, cost）
      import('../daemon/metrics.js').then(({ recordAgentSessionFromLog }) => {
        recordAgentSessionFromLog(
          state.config.worktree,
          state.sessionId,
          sessionName === 'analyst' ? 'analyst' as const : 'executor' as const,
          `daemon-${sessionName}-${state.taskCount}`,
        );
      }).catch(() => {});

      writeTaskLog(buildLog({
        command: cmd.replace(/sk-[a-zA-Z0-9]+/g, 'sk-***'),
        success: true,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheHitTokens: usage.cacheHitTokens,
        durationMs,
        outputFile: job.outputFile,
        outputSize: output?.length,
      }));

      return {
        success: true,
        output,
        sessionId: sessionName,
        durationMs,
      };
    } catch (err) {
      // Unexpected error (JSON parsing, file I/O, etc.)
      const durationMs = Date.now() - startTime;
      const errorMsg = err instanceof Error ? err.message : String(err);

      logger.error('[SessionManager] Unexpected error', {
        session: sessionName,
        task: state.taskCount + 1,
        durationMs,
        error: errorMsg.slice(0, 200),
      });

      recordPipelineRun({
        source: 'pipeline',
        phase: sessionName === 'analyst' ? 'analyst' : 'executor',
        taskName: `daemon-${sessionName}-${state.taskCount + 1}`,
        model,
        inputTokens: 0,
        outputTokens: 0,
        cacheHitTokens: 0,
        durationMs,
        success: false,
        error: errorMsg.slice(0, 300),
        sessionId: state.sessionId,
      }).catch(e => logger.warn('[SessionManager] Metrics record failed', { error: String(e) }));

      writeTaskLog(buildLog({
        command: '', success: false, errorType: 'parse_error',
        errorDetail: errorMsg.slice(0, 300), durationMs,
      }));

      return {
        success: false,
        error: errorMsg.slice(0, 300),
        sessionId: sessionName,
        durationMs,
      };
    } finally {
      state.isBusy = false;
    }
  }

  /** Graceful shutdown: wait for running tasks to complete (with timeout) */
  async shutdown(maxWaitMs = 60_000): Promise<void> {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      const busy = [...this.sessions.values()].filter(s => s.isBusy);
      if (busy.length === 0) return;
      logger.info('[SessionManager] Waiting for tasks to finish before shutdown', {
        busy: busy.map(s => `task-${s.taskCount}`).join(', '),
        remainingMs: deadline - Date.now(),
      });
      await new Promise(r => setTimeout(r, 2000));
    }
    logger.warn('[SessionManager] Shutdown timeout reached, forcing exit');
  }

  getStatus(sessionName: string): { name: string; isBusy: boolean; lastUsed: number; taskCount: number; worktree: string; persistent: boolean } | null {
    const state = this.sessions.get(sessionName);
    if (!state) return null;
    return {
      name: sessionName,
      isBusy: state.isBusy,
      lastUsed: state.lastUsed,
      taskCount: state.taskCount,
      worktree: state.config.worktree,
      persistent: state.config.persistent,
    };
  }

  // M6: cache hit rate metric
  getCacheHitRate(): string {
    const total = this.cacheHits + this.cacheMisses;
    if (total === 0) return 'N/A';
    return `${((this.cacheHits / total) * 100).toFixed(0)}% (${this.cacheHits}/${total})`;
  }

  getAllStatus() {
    return Array.from(this.sessions.keys()).map(name => this.getStatus(name));
  }

  private ensureWorktree(config: SessionConfig): void {
    if (!fs.existsSync(config.worktree)) {
      fs.mkdirSync(config.worktree, { recursive: true });
    }
    // 确保子会话不会触发权限提示 (--dangerously-skip-permissions 在 root 下禁用)
    const claudeDir = path.join(config.worktree, '.claude');
    const settingsPath = path.join(claudeDir, 'settings.json');
    if (!fs.existsSync(settingsPath)) {
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify({
        permissions: { defaultMode: 'bypassPermissions' },
      }, null, 2), 'utf-8');
    }
  }
}
