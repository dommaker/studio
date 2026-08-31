/**
 * Output Capture — 进度读取 + 输出文件收集 + session 指标记录
 *
 * P11-02: Extracted from agent-executor.ts
 * #361: 事件落盘收一 — 5 个同构 emit 全部经 @dommaker/studio-shared 的
 * writeStudioEvent 唯一入口写入（StudioEvent envelope 形态）。此前自抄
 * appendJsonl 且在模块加载期固化 studioPath('logs') 直连路径，绕过
 * STUDIO_EVENTS_FILE 测试隔离 → vitest 下 runner 事件落生产 logs。
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { logger, writeStudioEvent } from '@dommaker/studio-shared';
import { parseSessionMetrics } from '@dommaker/studio-shared/harness';

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
 * 记录 session 指标到 StudioEvent（agent_session）
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
    await writeStudioEvent('agent_session', {
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
      stdout: opts.stdout.slice(0, 2000),
    }, { source: 'agent-executor' });
  } catch (metricErr) {
    logger.warn('[OutputCapture] Failed to record session metrics', { error: String(metricErr) });
  }
}

/**
 * #174/#361: session:start/end 附加字段（WU 归属 + transcript 归档路径）
 * 有值才并入 payload；undefined 的键不出现（JSON.stringify 语义），无 extras 时行为不变。
 * session:start 与 session:end 必须携带同一份 extras —— 此前成功路径的 end 经
 * processSessionOutput 发射时丢失 extras，同一事件出现两种 payload 形态。
 */
export interface SessionEventExtras {
  workUnitId?: string;
  transcriptPath?: string;
}

/**
 * 发射 session:start 事件
 */
export async function emitSessionStart(sessionId: string, executionId: string, sessionCount: number, extras?: SessionEventExtras): Promise<void> {
  await writeStudioEvent('session:start', {
    sessionId,
    agentId: executionId,
    executionId,
    sessionCount,
    ...(extras?.workUnitId ? { workUnitId: extras.workUnitId } : {}),
    ...(extras?.transcriptPath ? { transcriptPath: extras.transcriptPath } : {}),
  }, { source: 'agent-executor' });
}

/**
 * 发射 session:end 事件
 */
export async function emitSessionEnd(sessionId: string, executionId: string, sessionCount: number, extras?: SessionEventExtras): Promise<void> {
  await writeStudioEvent('session:end', {
    sessionId,
    agentId: executionId,
    executionId,
    sessionCount,
    ...(extras?.workUnitId ? { workUnitId: extras.workUnitId } : {}),
    ...(extras?.transcriptPath ? { transcriptPath: extras.transcriptPath } : {}),
  }, { source: 'agent-executor' });
}

/**
 * 发射 tool:call 事件 — 记录 agent 调用的工具及参数
 */
export async function emitToolCall(toolName: string, input: unknown, sessionId: string, executionId: string): Promise<void> {
  await writeStudioEvent('tool:call', { tool: toolName, input, sessionId, executionId }, { source: 'agent-executor' });
}

/**
 * 发射 file:change 事件 — 记录 agent 修改的文件路径
 */
export async function emitFileChange(filePath: string, sessionId: string, executionId: string): Promise<void> {
  await writeStudioEvent('file:change', { path: filePath, sessionId, executionId }, { source: 'agent-executor' });
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
