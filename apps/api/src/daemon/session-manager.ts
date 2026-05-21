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

    // Load or generate session UUID (persisted to worktree)
    const existingId = readSessionIdFile(config.worktree);
    let sessionId: string;
    let isNewSession: boolean;
    if (existingId) {
      sessionId = existingId;
      isNewSession = false; // 从文件加载 → 用 --continue 续接
    } else {
      sessionId = resolveSessionId(config.worktree);
      isNewSession = true;
    }

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
    });
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
      const cmd = [
        `cd "${state.config.worktree}"`,
        `&&`,
        `cat '${promptFile}'`,
        `|`,
        `claude`,
        `--print`,
        `--output-format json`,
        `--dangerously-skip-permissions`,
        sessionFlag,
        `2>&1`,
      ].join(' ');

      logger.info('[SessionManager] Running task', {
        session: sessionName,
        task: state.taskCount + 1,
        isFirstTask,
        model,
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
        // --continue 不会因 session 丢失而报错（会静默创建新 session），所以不需要恢复重试
        const errMsg = execErr instanceof Error ? execErr.message : String(execErr);
        const stderr = (execErr as any)?.stderr?.toString() || '';

        const durationMs = Date.now() - startTime;
        const userMsg = stderr.slice(0, 300) || errMsg.slice(0, 300);
        logger.error('[SessionManager] Task failed', { session: sessionName, error: userMsg.slice(0, 200) });

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
      logger.info('[SessionManager] Task completed', {
        session: sessionName,
        task: state.taskCount,
        durationMs,
        outputLen: output?.length || 0,
        inputTokens: usage.inputTokens,
        cacheHitTokens: usage.cacheHitTokens,
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

  getStatus(sessionName: string) {
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
  }
}
