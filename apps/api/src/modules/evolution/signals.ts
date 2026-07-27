/**
 * E1 约束进化（vision §6 / docs/plans/2026-07-flywheel-repair.md §4）：路径解析 + 信号加载。
 *
 * 三个信号源（全部文件型，tmp dir 可注入）：
 *   1. harness 约束 traces：<repoRoot>/.harness/logs/traces.log（ExecutionTrace JSONL，
 *      由 @dommaker/harness TraceCollector 写入，供 autoEvolve 使用）
 *   2. 工具调用 traces：<eventsDir>/studio.jsonl（tool:call 事件，eventsDir 经
 *      resolveEventsDir() 统一解析 —— R2 断点 D 修复后的唯一事件目录）
 *   3. 执行结果事件：<studioEventsFile>（knowledge:outcome:* 事件，含 consumedKnowledge
 *      反馈数据 —— R1 断点 A 修复后有值）
 */
import os from 'node:os';
import path from 'node:path';
import type { ExecutionTrace } from '@dommaker/harness';
import { FileStore, resolveEventsDir } from '@dommaker/studio-shared';
import { resolveStudioLogFile } from '../../utils/studio-log-path.js';

export interface EvolutionPaths {
  /** 仓库根（.harness/ 与 .agents/ 所在），默认 process.cwd() */
  repoRoot: string;
  /** harness 自定义约束文件（iron-law/guideline 提案的写入目标） */
  constraintsFile: string;
  /** harness 约束 trace 文件（autoEvolve 输入） */
  traceFile: string;
  /** 角色预设目录（role-preset 提案的写入目标：<rolesDir>/<name>.yaml） */
  rolesDir: string;
  /** 统一事件目录（tool:call traces） */
  eventsDir: string;
  /** StudioEvent 流（knowledge:outcome:* 等） */
  studioEventsFile: string;
}

export function resolveEvolutionPaths(overrides?: Partial<EvolutionPaths>): EvolutionPaths {
  const repoRoot = overrides?.repoRoot ?? process.cwd();
  return {
    repoRoot,
    constraintsFile: overrides?.constraintsFile ?? path.join(repoRoot, '.harness', 'custom-constraints.yml'),
    traceFile: overrides?.traceFile ?? path.join(repoRoot, '.harness', 'logs', 'traces.log'),
    rolesDir: overrides?.rolesDir ?? path.join(repoRoot, '.agents', 'roles'),
    eventsDir: overrides?.eventsDir ?? resolveEventsDir(),
    studioEventsFile: overrides?.studioEventsFile ?? resolveStudioLogFile('studio-events.jsonl'),
  };
}

export interface ToolCallEvent {
  type: string;
  tool?: string;
  success?: boolean;
  durationMs?: number;
  timestamp?: number;
  caller?: string;
  riskLevel?: string;
}

export interface OutcomeEvent {
  executionId?: string;
  agentType?: string;
  success: boolean;
  consumedKnowledge: unknown[];
  createdAt: string;
}

export interface WindowSignals {
  constraintTraces: ExecutionTrace[];
  toolCalls: ToolCallEvent[];
  outcomes: OutcomeEvent[];
}

interface StudioEventRow {
  type?: string;
  createdAt?: string;
  payload?: string;
}

/** 加载窗口期内的三类信号（文件缺失 → 空数组，绝不抛出）。 */
export async function loadWindowSignals(
  paths: EvolutionPaths,
  windowHours: number,
  fileStore: FileStore,
): Promise<WindowSignals> {
  const sinceMs = Date.now() - windowHours * 3600_000;

  const constraintTraces = (await fileStore.readJsonl<ExecutionTrace>(paths.traceFile).catch(() => []))
    .filter(t => t && typeof t.timestamp === 'number' && t.timestamp >= sinceMs && typeof t.constraintId === 'string');

  const toolCalls = (await fileStore.readJsonl<ToolCallEvent>(path.join(paths.eventsDir, 'studio.jsonl')).catch(() => []))
    .filter(e => e && e.type === 'tool:call' && typeof e.timestamp === 'number' && (e.timestamp as number) >= sinceMs);

  const outcomeRows = (await fileStore.readJsonl<StudioEventRow>(paths.studioEventsFile).catch(() => []))
    .filter(r => r && typeof r.type === 'string' && r.type.startsWith('knowledge:outcome:')
      && typeof r.createdAt === 'string' && new Date(r.createdAt).getTime() >= sinceMs);

  const outcomes: OutcomeEvent[] = [];
  for (const row of outcomeRows) {
    try {
      const p = JSON.parse(row.payload ?? '{}');
      outcomes.push({
        executionId: p.executionId,
        agentType: p.agentType,
        success: p.success === true,
        consumedKnowledge: Array.isArray(p.consumedKnowledge) ? p.consumedKnowledge : [],
        createdAt: row.createdAt as string,
      });
    } catch { /* skip corrupt payload */ }
  }

  return { constraintTraces, toolCalls, outcomes };
}
