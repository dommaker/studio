/**
 * Task Executor — AS-020 P5-03: Agent execution lifecycle
 *
 * 【未接线】daemon 客户端三件套之一，随 claim-loop 一起接入（见 claim-loop.ts 头注）。
 * 勿按死代码清理（2026-08-04 复审决议）。
 *
 * spawn → capture stdout → poll cancel → POST complete/fail → session pinning
 *
 * P5-04 output capture is inline (stream-json line parser + batcher).
 */

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger, parseStreamLine as parseStreamLineShared, extractFilePath, type StreamEvent, FileStore } from '@dommaker/studio-shared';
import { buildSpawnArgs, type AgentCliParams } from './cli-adapter.js';
import { resolveStudioLogFile } from '../utils/studio-log-path.js';
import type { ProviderName } from './cli-scanner.js';
import type { ClaimedTask } from './claim-loop.js';
import type { DetectedRuntime } from './cli-scanner.js';

const STUDIO_EVENTS_JSONL = resolveStudioLogFile('studio-events.jsonl');
const fileStore = new FileStore();

export interface TaskExecutorConfig {
  serverUrl: string;
  token: string;
  workspaceId: string;
  workspaceRoot: string;
  /** Detected runtimes (provider → path) */
  runtimes: DetectedRuntime[];
  /** Cancel polling interval ms (default 5000) */
  cancelPollMs?: number;
  /** Agent timeout ms (default 2h) */
  timeoutMs?: number;
  /** Max turns for agent (default 50) */
  maxTurns?: number;
}

interface OutputEvent {
  seq: number;
  type: 'text' | 'tool_use' | 'result';
  content?: string;
  tool?: string;
  input?: unknown;
}

const DEFAULT_CANCEL_POLL = 5_000;
const DEFAULT_TIMEOUT = 2 * 60 * 60 * 1000; // 2h
const DEFAULT_MAX_TURNS = 50;
const BATCH_SIZE = 10;
const BATCH_INTERVAL = 2_000;

export class TaskExecutor {
  private config: TaskExecutorConfig;
  private processes = new Map<string, ChildProcess>();

  constructor(config: TaskExecutorConfig) {
    this.config = config;
  }

  /**
   * Execute a claimed task. Returns when task completes or fails.
   */
  async execute(task: ClaimedTask): Promise<void> {
    const startTime = Date.now();
    const workDir = this.ensureWorkDir(task);

    logger.info('[TaskExecutor] Starting', { taskId: task.id, runtimeId: task.runtimeId });

    // Resolve runtime
    const runtime = this.resolveRuntime(task.runtimeId);
    if (!runtime) {
      await this.reportFail(task.id, `Runtime not found: ${task.runtimeId}`, startTime);
      return;
    }

    // Build spawn args
    // 不传 model —— 由角色绑定的 CLI 自身配置决定（2026-07-28 退役 tier→模型名映射）
    const spawnArgs = buildSpawnArgs(runtime.provider, {
      outputFormat: 'stream-json',
      sessionId: task.sessionId ?? undefined,
      maxTurns: this.config.maxTurns ?? DEFAULT_MAX_TURNS,
      prompt: task.prompt,
      cwd: workDir,
    }, runtime.path);

    // Spawn agent
    const child = this.spawnAgent(spawnArgs, workDir, task.id);
    this.processes.set(task.id, child);

    // Collect output events
    const events: OutputEvent[] = [];
    let seq = 0;
    let lastFlush = Date.now();
    let stdoutBuffer = '';

    child.stdout?.on('data', (data: Buffer) => {
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const parsed = this.parseStreamLine(trimmed, ++seq);
        if (parsed) {
          events.push(parsed);
          if (parsed.type === 'tool_use') {
            this.emitToolEvent(task, parsed);
          }
        }

        // Batch flush
        if (events.length >= BATCH_SIZE || Date.now() - lastFlush > BATCH_INTERVAL) {
          this.flushMessages(task.id, events.splice(0));
          lastFlush = Date.now();
        }
      }
    });

    let stderrOutput = '';
    child.stderr?.on('data', (data: Buffer) => {
      stderrOutput += data.toString();
    });

    // Cancel polling
    const cancelTimer = setInterval(async () => {
      try {
        const cancelled = await this.checkCancelled(task.id);
        if (cancelled) {
          logger.info('[TaskExecutor] Task cancelled', { taskId: task.id });
          child.kill('SIGTERM');
        }
      } catch {
        // ignore poll errors
      }
    }, this.config.cancelPollMs ?? DEFAULT_CANCEL_POLL);

    // Timeout
    const timeoutTimer = setTimeout(() => {
      logger.warn('[TaskExecutor] Timeout, killing', { taskId: task.id });
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 10_000);
    }, this.config.timeoutMs ?? DEFAULT_TIMEOUT);

    // Wait for exit
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code));
    });

    clearTimeout(timeoutTimer);
    clearInterval(cancelTimer);
    this.processes.delete(task.id);

    // Flush remaining events
    if (events.length > 0) {
      await this.flushMessages(task.id, events.splice(0));
    }

    const elapsedMs = Date.now() - startTime;

    // Report result
    if (exitCode === 0) {
      await this.reportComplete(task.id, stdoutBuffer || '', elapsedMs);
      // Session pinning
      if (task.sessionId) {
        await this.reportSession(task.id, task.sessionId, workDir);
      }
    } else {
      // stderr 优先，stdout buffer 尾部兜底（agent 可能把错误输出到 stdout）
      const tail = stdoutBuffer.slice(-500).trim();
      const error = stderrOutput.slice(0, 500) || tail || `Exit code: ${exitCode}`;
      await this.reportFail(task.id, error, elapsedMs);
    }

    logger.info('[TaskExecutor] Done', { taskId: task.id, exitCode, elapsedMs });
  }

  /**
   * Kill a running task process.
   */
  kill(taskId: string): boolean {
    const child = this.processes.get(taskId);
    if (!child) return false;
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 10_000);
    return true;
  }

  /**
   * Number of running processes.
   */
  getRunningCount(): number {
    return this.processes.size;
  }

  // ─── Private ───

  private ensureWorkDir(task: ClaimedTask): string {
    const workDir = path.join(
      os.homedir(),
      '.studio',
      'workspaces',
      this.config.workspaceId,
      task.id,
      'workdir',
    );
    fs.mkdirSync(workDir, { recursive: true });
    return workDir;
  }

  private resolveRuntime(runtimeId: string | null): DetectedRuntime | undefined {
    if (!runtimeId) return this.config.runtimes[0];
    return this.config.runtimes.find(r => r.provider === runtimeId);
  }

  private spawnAgent(spawnArgs: ReturnType<typeof buildSpawnArgs>, cwd: string, taskId: string): ChildProcess {
    const child = spawn(spawnArgs.command, spawnArgs.args, {
      cwd,
      env: { ...process.env, ...spawnArgs.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Write prompt to stdin if needed
    if (spawnArgs.promptViaStdin && spawnArgs.args.length > 0) {
      // Prompt will be in task.prompt, already in args for some providers
    }

    child.on('error', (err) => {
      logger.error('[TaskExecutor] Spawn error', { taskId, error: String(err) });
    });

    return child;
  }

  /**
   * Fire-and-forget: write tool:call + optional file:change StudioEvent.
   * Uses .catch() — never awaits, never blocks stdout processing.
   * Uses shared extractFilePath from @dommaker/studio-shared for file path detection.
   */
  private emitToolEvent(task: ClaimedTask, parsed: OutputEvent): void {
    const sessionId = task.sessionId ?? task.id;
    const tool = parsed.tool ?? 'unknown';
    const input = (parsed.input ?? {}) as Record<string, unknown>;

    fileStore.appendJsonl(STUDIO_EVENTS_JSONL, {
      type: 'tool:call',
      source: 'executor',
      payload: JSON.stringify({ tool, input, sessionId }),
      createdAt: new Date().toISOString(),
    }).catch((err: unknown) => {
      logger.warn('[TaskExecutor] tool:call event write failed', { taskId: task.id, error: String(err) });
    });

    // Use shared extractFilePath (replaces hardcoded tool name list)
    const filePath = extractFilePath(tool, input);
    if (filePath) {
      fileStore.appendJsonl(STUDIO_EVENTS_JSONL, {
        type: 'file:change',
        source: 'executor',
        payload: JSON.stringify({ path: filePath, sessionId }),
        createdAt: new Date().toISOString(),
      }).catch((err: unknown) => {
        logger.warn('[TaskExecutor] file:change event write failed', { taskId: task.id, error: String(err) });
      });
    }
  }

  /**
   * Parse a single stream-json line into an OutputEvent.
   * Uses shared parseStreamLine from @dommaker/studio-shared for JSON parsing,
   * then converts to the OutputEvent format expected by the server.
   */
  private parseStreamLine(line: string, seq: number): OutputEvent | null {
    const event = parseStreamLineShared(line);
    if (!event) {
      // Non-JSON line — treat as text
      const trimmed = line.trim();
      return trimmed ? { seq, type: 'text', content: trimmed } : null;
    }

    // Claude Code format: { type: "assistant", content: [...] }
    if (event.type === 'assistant' && Array.isArray(event.content)) {
      for (const block of event.content) {
        if (block.type === 'text' && block.text) {
          return { seq, type: 'text', content: block.text };
        }
        if (block.type === 'tool_use' && block.name) {
          return { seq, type: 'tool_use', tool: block.name, input: block.input };
        }
      }
    }

    // Result format: { type: "result", result: "..." }
    if (event.type === 'result' && event.result) {
      return { seq, type: 'result', content: String(event.result) };
    }

    return null;
  }

  private async flushMessages(taskId: string, events: OutputEvent[]): Promise<void> {
    if (events.length === 0) return;

    try {
      const url = `${this.config.serverUrl.replace(/\/$/, '')}/api/v1/daemon/tasks/${taskId}/messages`;
      await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.token}`,
        },
        body: JSON.stringify({ messages: events }),
      });
    } catch (err) {
      logger.error('[TaskExecutor] flushMessages failed', { taskId, error: String(err) });
    }
  }

  private async reportComplete(taskId: string, output: string, elapsedMs: number): Promise<void> {
    try {
      const url = `${this.config.serverUrl.replace(/\/$/, '')}/api/v1/daemon/tasks/${taskId}/complete`;
      await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.token}`,
        },
        body: JSON.stringify({ output: output.slice(0, 10_000), elapsedMs }),
      });
    } catch (err) {
      logger.error('[TaskExecutor] reportComplete failed', { taskId, error: String(err) });
    }
  }

  private async reportFail(taskId: string, error: string, elapsedMs: number): Promise<void> {
    try {
      const url = `${this.config.serverUrl.replace(/\/$/, '')}/api/v1/daemon/tasks/${taskId}/fail`;
      await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.token}`,
        },
        body: JSON.stringify({ error, failureReason: error.slice(0, 200), elapsedMs }),
      });
    } catch (err) {
      logger.error('[TaskExecutor] reportFail failed', { taskId, error: String(err) });
    }
  }

  private async reportSession(taskId: string, sessionId: string, workDir: string): Promise<void> {
    try {
      const url = `${this.config.serverUrl.replace(/\/$/, '')}/api/v1/daemon/tasks/${taskId}/session`;
      await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.token}`,
        },
        body: JSON.stringify({ session_id: sessionId, work_dir: workDir }),
      });
    } catch (err) {
      logger.error('[TaskExecutor] reportSession failed', { taskId, error: String(err) });
    }
  }

  private async checkCancelled(taskId: string): Promise<boolean> {
    const url = `${this.config.serverUrl.replace(/\/$/, '')}/api/v1/daemon/tasks/${taskId}/status`;
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${this.config.token}` },
    });

    if (!response.ok) return false;

    const data = await response.json() as { status?: string };
    return data.status === 'cancelled';
  }
}
