/**
 * Output Capture — 进度读取 + 输出文件收集 + session 指标记录
 *
 * P11-02: Extracted from agent-executor.ts
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { logger } from '@dommaker/studio-shared';
import { parseSessionMetrics } from '@dommaker/studio-shared/harness';
import { prisma } from '@dommaker/studio-prisma';

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
  modelTier: string;
  stage?: string;
  sessionCount: number;
  isFirstSession: boolean;
  sessionMs: number;
  promptSize: number;
  constraintHash: string;
  constraintSize: number;
}): Promise<void> {
  try {
    const metrics = parseSessionMetrics(opts.stdout);
    await prisma.studioEvent.create({
      data: {
        type: 'agent_session',
        source: 'agent-executor',
        executionId: opts.executionId,
        agentRole: opts.agentRole,
        modelTier: opts.modelTier,
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
      },
    });
  } catch (metricErr) {
    logger.warn('[OutputCapture] Failed to record session metrics', { error: String(metricErr) });
  }
}

/**
 * 发射 session:start 事件
 */
export async function emitSessionStart(sessionId: string, executionId: string, sessionCount: number): Promise<void> {
  try {
    await prisma.studioEvent.create({
      data: {
        type: 'session:start',
        source: 'agent-executor',
        payload: JSON.stringify({ sessionId, agentId: executionId, executionId, sessionCount }),
      },
    });
  } catch { /* non-blocking */ }
}

/**
 * 发射 session:end 事件
 */
export async function emitSessionEnd(sessionId: string, executionId: string, sessionCount: number): Promise<void> {
  try {
    await prisma.studioEvent.create({
      data: {
        type: 'session:end',
        source: 'agent-executor',
        payload: JSON.stringify({ sessionId, agentId: executionId, executionId, sessionCount }),
      },
    });
  } catch { /* non-blocking */ }
}

/**
 * 记录执行错误到 GoalExecution
 */
export async function recordExecutionError(opts: {
  executionId: string;
  errMsg: string;
  errStack?: string;
  stderrText: string;
  sessionCount: number;
  cumulativeSessionMs: number;
  signal?: string;
  code?: number;
}): Promise<void> {
  try {
    await prisma.goalExecution.update({
      where: { id: opts.executionId },
      data: {
        status: 'failed',
        error: JSON.stringify({
          message: opts.errMsg,
          stack: opts.errStack,
          stderr: opts.stderrText,
          sessionCount: opts.sessionCount,
          cumulativeSessionMs: opts.cumulativeSessionMs,
          signal: opts.signal,
          code: opts.code,
          timestamp: Date.now(),
        }),
      },
    });
  } catch (e) {
    logger.warn('[OutputCapture] Failed to store error details', { error: String(e) });
  }
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
