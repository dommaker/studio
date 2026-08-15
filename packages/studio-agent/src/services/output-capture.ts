/**
 * Output Capture — 进度读取 + 输出文件收集 + session 指标记录
 *
 * P11-02: Extracted from agent-executor.ts
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { logger, FileStore } from '@dommaker/studio-shared';
import { parseSessionMetrics } from '@dommaker/studio-shared/harness';
import { studioPath } from '@dommaker/studio-shared/studio-dir';

const STUDIO_EVENTS_JSONL = studioPath('logs', 'studio-events.jsonl');
const fileStore = new FileStore();

// .progress.json 结构
export interface ProgressReport {
  taskId: string;
  allComplete: boolean;
  sessionCount: number;
  currentStep: string;
  completedSteps: string[];
  testResults: { passed: number; failed: number; total: number };
  lastCheckpoint: string;
  notes: string;
}

/**
 * 读取 .progress.json
 */
export function readProgress(worktree: string): ProgressReport | null {
  try {
    const raw = fsSync.readFileSync(path.join(worktree, '.progress.json'), 'utf-8');
    return JSON.parse(raw) as ProgressReport;
  } catch {
    return null;
  }
}

/**
 * 收集 worktree 中的输出文件 (.md, .json)
 */
export async function collectOutputFiles(worktree: string): Promise<string[]> {
  const files: string[] = [];
  try {
    const entries = await fs.readdir(worktree);
    for (const entry of entries) {
      if (entry.endsWith('.md') || entry.endsWith('.json')) {
        files.push(path.join(worktree, entry));
      }
    }
  } catch (e) {
    logger.warn('[OutputCapture] Failed to collect output files', { error: String(e) });
  }
  return files;
}

/**
 * 解析 JSON envelope 并返回文本内容
 */
export function parseJsonEnvelope(stdout: string, taskId: string, executionId: string): { text: string; isError: boolean } {
  let text = stdout;
  let isError = false;
  try {
    const envelope = JSON.parse(stdout);
    if (envelope.is_error) { isError = true; text = ''; }
    if (envelope.result) text = envelope.result;
  } catch (e) {
    logger.error('[OutputCapture] Failed to parse JSON envelope', { taskId, executionId, error: String(e) });
  }
  return { text, isError };
}

/**
 * 记录 session 指标到 StudioEvent
 */
export async function recordSessionMetrics(opts: {
  stdout: string;
  executionId: string;
  agentRole: string;
  stage?: string;
  sessionCount: number;
  isFirstSession: boolean;
  sessionMs: number;
  promptSize: number;
  constraintHash: string;
  constraintSize: number;
  /** Stream-json usage override — when using --output-format stream-json, parseSessionMetrics can't extract tokens from the multi-line format. Pass pre-extracted usage here. */
  streamUsage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; model: string };
}): Promise<void> {
  try {
    const parsed = parseSessionMetrics(opts.stdout);
    // Stream-json usage takes precedence when available (non-zero)
    const metrics = opts.streamUsage && opts.streamUsage.inputTokens > 0
      ? {
          ...parsed,
          tokenInput: opts.streamUsage.inputTokens,
          tokenOutput: opts.streamUsage.outputTokens,
          tokenCacheRead: opts.streamUsage.cacheReadTokens,
          tokenCacheWrite: opts.streamUsage.cacheCreationTokens,
          modelName: opts.streamUsage.model || parsed.modelName,
        }
      : parsed;
    await fileStore.appendJsonl(STUDIO_EVENTS_JSONL, {
      type: 'agent_session',
      source: 'agent-executor',
      executionId: opts.executionId,
      agentRole: opts.agentRole,
      modelName: metrics.modelName,
      stage: opts.stage,
      sessionCount: opts.sessionCount,
      isContinued: !opts.isFirstSession,
      durationMs: opts.sessionMs,
      numTurns: metrics.numTurns,
      promptSize: opts.promptSize,
      tokenInput: metrics.tokenInput,
      tokenOutput: metrics.tokenOutput,
      tokenCacheRead: metrics.tokenCacheRead,
      tokenCacheWrite: metrics.tokenCacheWrite,
      costUsd: metrics.costUsd,
      serviceTier: metrics.serviceTier,
      constraintHash: opts.constraintHash,
      constraintSize: opts.constraintSize,
      payload: JSON.stringify({ stdout: opts.stdout.slice(0, 2000) }),
      createdAt: new Date().toISOString(),
    });
  } catch (metricErr) {
    logger.warn('[OutputCapture] Failed to record session metrics', { error: String(metricErr) });
  }
}

/**
 * #174: session:start/end 附加字段（WU 归属 + transcript 归档路径）
 * 有值才并入 payload；undefined 的键不出现（JSON.stringify 语义），无 extras 时行为不变。
 */
export interface SessionEventExtras {
  workUnitId?: string;
  transcriptPath?: string;
}

/**
 * 发射 session:start 事件
 */
export async function emitSessionStart(sessionId: string, executionId: string, sessionCount: number, extras?: SessionEventExtras): Promise<void> {
  try {
    await fileStore.appendJsonl(STUDIO_EVENTS_JSONL, {
      type: 'session:start',
      source: 'agent-executor',
      payload: JSON.stringify({
        sessionId, agentId: executionId, executionId, sessionCount,
        ...(extras?.workUnitId ? { workUnitId: extras.workUnitId } : {}),
        ...(extras?.transcriptPath ? { transcriptPath: extras.transcriptPath } : {}),
      }),
      createdAt: new Date().toISOString(),
    });
  } catch { /* non-blocking */ }
}

/**
 * 发射 session:end 事件
 */
export async function emitSessionEnd(sessionId: string, executionId: string, sessionCount: number, extras?: SessionEventExtras): Promise<void> {
  try {
    await fileStore.appendJsonl(STUDIO_EVENTS_JSONL, {
      type: 'session:end',
      source: 'agent-executor',
      payload: JSON.stringify({
        sessionId, agentId: executionId, executionId, sessionCount,
        ...(extras?.workUnitId ? { workUnitId: extras.workUnitId } : {}),
        ...(extras?.transcriptPath ? { transcriptPath: extras.transcriptPath } : {}),
      }),
      createdAt: new Date().toISOString(),
    });
  } catch { /* non-blocking */ }
}

/**
 * 发射 tool:call 事件 — 记录 agent 调用的工具及参数
 */
export async function emitToolCall(toolName: string, input: unknown, sessionId: string, executionId: string): Promise<void> {
  try {
    await fileStore.appendJsonl(STUDIO_EVENTS_JSONL, {
      type: 'tool:call',
      source: 'agent-executor',
      executionId,
      payload: JSON.stringify({ tool: toolName, input, sessionId }),
      createdAt: new Date().toISOString(),
    });
  } catch { /* non-blocking */ }
}

/**
 * 发射 file:change 事件 — 记录 agent 修改的文件路径
 */
export async function emitFileChange(filePath: string, sessionId: string, executionId: string): Promise<void> {
  try {
    await fileStore.appendJsonl(STUDIO_EVENTS_JSONL, {
      type: 'file:change',
      source: 'agent-executor',
      executionId,
      payload: JSON.stringify({ path: filePath, sessionId }),
      createdAt: new Date().toISOString(),
    });
  } catch { /* non-blocking */ }
}

/**
 * [DEPRECATED] GoalExecution 已迁移至 WorkUnit
 * 保留签名兼容 caller，实际记录不再写入已删除的 GoalExecution 表
 */
export async function recordExecutionError(_opts: {
  executionId: string;
  errMsg: string;
  errStack?: string;
  stderrText: string;
  stdoutText?: string;
  sessionCount: number;
  cumulativeSessionMs: number;
  signal?: string;
  code?: number;
}): Promise<void> {
  logger.warn('[OutputCapture] recordExecutionError deprecated, GoalExecution table removed');
}

// 约束 metadata 缓存
let _constraintHash = '';
let _constraintSize = 0;

/**
 * 获取约束 metadata（hash + size），启动时加载一次
 */
export async function getConstraintMeta(): Promise<{ hash: string; size: number }> {
  if (_constraintHash) return { hash: _constraintHash, size: _constraintSize };
  try {
    const { execSync } = await import('child_process');
    const output = execSync('npx harness constraints --json 2>/dev/null || node -e "console.log(JSON.stringify({hash:\\"unknown\\",textSize:{total:0}}))"', {
      encoding: 'utf-8', timeout: 10_000, stdio: 'pipe',
    });
    const meta = JSON.parse(output);
    _constraintHash = meta.hash || 'unknown';
    _constraintSize = meta.textSize?.total || 0;
  } catch {
    _constraintHash = 'unknown';
  }
  return { hash: _constraintHash, size: _constraintSize };
}
