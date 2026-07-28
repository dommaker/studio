// Session Manager — manages persistent Claude Code sessions via --session-id + --continue
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { logger, parseStreamEvents, extractUsage, extractWriteContent } from '@dommaker/studio-shared';
import { readSessionIdFile } from '@dommaker/studio-shared/node';
import type { ModelTier } from '@dommaker/studio-shared';
import { agentRunner } from '@dommaker/studio-agent';
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
    const isFirstTask = state.taskCount === 0;
    // tier 仅作任务规格标签记入日志；模型由角色绑定的 CLI 自身配置决定（2026-07-28 起不再解析 tier→模型名）
    const model = state.config.modelTier;
    const phase = sessionName === 'analyst' ? 'analyst' : 'executor';
    const isAnalyst = sessionName === 'analyst';

    // Build session flags (session-id / --continue)
    const sessionFlag = isFirstTask
      ? (state.isNewSession
          ? `--session-id ${state.sessionId} --name "${sessionName}"`
          : '--continue')
      : '--continue';

    // Build base log entry
    const taskIndex = state.taskCount + 1;
    const buildLog = (overrides: Partial<TaskLog>): TaskLog => ({
      timestamp: new Date().toISOString(),
      session: sessionName,
      sessionId: state.sessionId,
      taskIndex,
      model,
      phase,
      command: '',
      durationMs: Date.now() - startTime,
      success: false,
      inputTokens: 0,
      outputTokens: 0,
      cacheHitTokens: 0,
      ...overrides,
    });

    logger.info('[SessionManager] Running task (via AgentRunner)', {
      session: sessionName,
      task: taskIndex,
      isFirstTask,
      model,
      isNewSession: state.isNewSession,
      sessionFlag,
      sessionId: state.sessionId,
    });

    try {
      // P9: Delegate to AgentRunner lightweight mode
      const execId = `daemon-${sessionName}-${taskIndex}`;
      const result = await agentRunner.executeLightweight({
        id: execId,
        executionId: state.sessionId,
        provider: 'claude',
        model: state.config.modelTier,
        prompt: job.prompt,
        timeoutMs: state.config.timeoutMs,
        parameters: {
          sessionFlags: sessionFlag,
          agentRole: isAnalyst ? 'analyst' : 'executor',
          worktree: state.config.worktree,
          extraEnv: job.env,
        },
      });

      const durationMs = result.totalDurationMs || (Date.now() - startTime);

      if (!result.success) {
        const errorMsg = result.error || 'Agent execution failed';
        const stdoutTail = result.failureLog || '';

        // P0.3 fix: first task failure — regenerate session-id
        if (isFirstTask && state.isNewSession) {
          const sessionIdFile = path.join(state.config.worktree, '.daemon', 'session-id');
          try { fs.unlinkSync(sessionIdFile); } catch {}
          state.sessionId = crypto.randomUUID();
        }

        writeTaskLog(buildLog({
          command: '', success: false,
          errorType: classifyTaskError(errorMsg + stdoutTail),
          errorDetail: errorMsg.slice(0, 300),
          stdoutPreview: stdoutTail.slice(0, 500), durationMs,
        }));

        return { success: false, error: errorMsg.slice(0, 300), sessionId: sessionName, durationMs };
      }

      // Success path
      state.lastUsed = Date.now();
      state.taskCount++;
      const wasNewSession = state.isNewSession;
      state.isNewSession = false;

      // Parse usage from .agent.log (stream-json format)
      let usage = { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 };
      try {
        const agentLogPath = path.join(state.config.worktree, '.agent.log');
        if (fs.existsSync(agentLogPath)) {
          const logContent = fs.readFileSync(agentLogPath, 'utf-8');
          const events = parseStreamEvents(logContent);
          const extracted = extractUsage(events);
          usage = {
            inputTokens: extracted.inputTokens,
            outputTokens: extracted.outputTokens,
            cacheHitTokens: extracted.cacheReadTokens + extracted.cacheCreationTokens,
          };
        }
      } catch (e) {
        logger.warn('[SessionManager] Failed to parse .agent.log for usage', { error: String(e) });
      }

      // Session cache loss detection
      if (isFirstTask && !wasNewSession && usage.inputTokens > 10_000) {
        this.cacheMisses++;
        logger.warn('[SessionManager] Session cache lost — regenerating session-id', {
          session: sessionName, oldSessionId: state.sessionId,
          inputTokens: usage.inputTokens, cacheHitRate: this.getCacheHitRate(),
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
      } else if (job.outputFile && !path.isAbsolute(job.outputFile)) {
        // P0: Resolve relative outputFile against worktree — API CWD may differ
        const worktreeOutputFile = path.join(state.config.worktree, job.outputFile);
        if (fs.existsSync(worktreeOutputFile)) {
          output = fs.readFileSync(worktreeOutputFile, 'utf-8');
          logger.info('[SessionManager] Output file found via worktree fallback', { original: job.outputFile, resolved: worktreeOutputFile });
        }
      }

      // P0.5: Output file recovery from .agent.log Write events
      if (!output && job.outputFile) {
        try {
          const agentLogPath = path.join(state.config.worktree, '.agent.log');
          if (fs.existsSync(agentLogPath)) {
            const logContent = fs.readFileSync(agentLogPath, 'utf-8');
            const logEvents = parseStreamEvents(logContent);
            const recovered = extractWriteContent(logEvents, job.outputFile);
            if (recovered !== null) {
              output = recovered;
              logger.info('[SessionManager] Output file recovered from .agent.log Write event', {
                path: job.outputFile, contentLength: recovered.length,
              });
            }
          }
        } catch (e) {
          logger.warn('[SessionManager] Output recovery from .agent.log failed', { error: String(e) });
        }
      }

      // Final fallback: outputText
      if (!output) {
        output = result.outputText || '';
      }

      // Extract turns from .agent.log
      let numTurns = 0;
      let sessionCost = 0;
      try {
        const agentLogPath = path.join(state.config.worktree, '.agent.log');
        if (fs.existsSync(agentLogPath)) {
          const logEvents = parseStreamEvents(fs.readFileSync(agentLogPath, 'utf-8'));
          for (const ev of logEvents) {
            if (ev.type === 'result') {
              const r = ev as unknown as Record<string, unknown>;
              numTurns = (r.num_turns as number) || numTurns;
              sessionCost = (r.total_cost_usd as number) || sessionCost;
            }
          }
        }
      } catch {}

      logger.info('[SessionManager] Task completed', {
        session: sessionName, task: state.taskCount, durationMs,
        turns: numTurns, outputLen: output?.length || 0,
        inputTokens: usage.inputTokens, cacheHitTokens: usage.cacheHitTokens,
        costUSD: Math.round(sessionCost * 1000) / 1000,
      });

      writeTaskLog(buildLog({
        command: `agentRunner.executeLightweight (${sessionFlag})`,
        success: true,
        inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
        cacheHitTokens: usage.cacheHitTokens, durationMs,
        outputFile: job.outputFile, outputSize: output?.length,
      }));

      // Trigger session:summary generation
      const { generateSessionSummary } = await import('../modules/events/session-summary-generator.js');
      generateSessionSummary(state.sessionId).catch((err: unknown) => {
        logger.warn('[SessionManager] SessionSummary generation failed', { sessionId: state.sessionId, error: String(err) });
      });

      return { success: true, output, sessionId: sessionName, durationMs };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMsg = err instanceof Error ? err.message : String(err);

      logger.error('[SessionManager] Unexpected error', {
        session: sessionName, task: taskIndex, durationMs,
        error: errorMsg.slice(0, 200),
      });

      writeTaskLog(buildLog({
        command: '', success: false, errorType: 'parse_error',
        errorDetail: errorMsg.slice(0, 300), durationMs,
      }));

      return { success: false, error: errorMsg.slice(0, 300), sessionId: sessionName, durationMs };
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
