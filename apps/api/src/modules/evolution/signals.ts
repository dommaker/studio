/**
 * E1 约束进化（vision §6 / docs/plans/2026-07-flywheel-repair.md §4）：路径解析 + 信号加载。
 *
 * 三个信号源（全部文件型，tmp dir 可注入 repoRoot/studioEventsFile）：
 *   1. harness 约束 traces：经 harness 公共 API `readProjectTracesReport(repoRoot).traces` 读取
 *      （#646：.harness/ 文件所有权归 harness，不再 FileStore 直读 traces.log；
 *      ExecutionTrace JSONL 由 @dommaker/harness TraceCollector 写入；
 *      原供 autoEvolve 使用，0.17.0 起为 constraints report 数据源，
 *      E1 (a) 链路挂起期间仅扫描计数）
 *   2. 工具调用 traces：<studioEventsFile>（tool:call 事件 —— D18 后与 knowledge
 *      事件同一统一事件文件；原 <eventsDir>/studio.jsonl 已收敛）
 *   3. 执行结果事件：<studioEventsFile>（knowledge:outcome:* 事件，含 consumedKnowledge
 *      反馈数据 —— R1 断点 A 修复后有值）
 */
import path from 'node:path';
import { readProjectTracesReport, type ExecutionTrace } from '@dommaker/harness';
import { resolveStudioEventsFile } from '@dommaker/studio-shared';
import { parseStudioEventPayload, getStudioEventTime } from '@dommaker/studio-shared';
// #335：窗口读口（尾部倒读 + 窗口外早停），替代 readJsonl 全量读
import { readStudioEventsSince } from '../../utils/studio-events-tail.js';

export interface EvolutionPaths {
  /** 仓库根（.harness/ 与 .agents/ 所在），默认 process.cwd() */
  repoRoot: string;
  /** 角色预设目录（role-preset 提案的写入目标：<rolesDir>/<name>.yaml） */
  rolesDir: string;
  /** 统一事件文件（tool:call、knowledge:outcome:* 等全部事件） */
  studioEventsFile: string;
}

export function resolveEvolutionPaths(overrides?: Partial<EvolutionPaths>): EvolutionPaths {
  const repoRoot = overrides?.repoRoot ?? process.cwd();
  return {
    repoRoot,
    rolesDir: overrides?.rolesDir ?? path.join(repoRoot, '.agents', 'roles'),
    studioEventsFile: overrides?.studioEventsFile ?? resolveStudioEventsFile(),
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

/** 加载窗口期内的三类信号（文件缺失 → 空数组，绝不抛出）；untilMs 固定观察窗口右端。 */
export async function loadWindowSignals(
  paths: EvolutionPaths,
  windowHours: number,
  untilMs: number = Date.now(),
): Promise<WindowSignals> {
  const sinceMs = untilMs - windowHours * 3600_000;

  // #646：traces 读取走 harness 公共 API（readProjectTracesReport 自带缺失文件/坏行容错 → 空数组，
  // 兼容包装 readProjectTraces 已随 harness 3.0.0/ADR-0041 删除，改取 .traces），
  // 窗口过滤在调用方按 timestamp 进行，行为口径与旧 FileStore 直读一致
  let traces: ExecutionTrace[] = [];
  try {
    traces = readProjectTracesReport(paths.repoRoot).traces;
  } catch { /* 容错口径：读取失败 = 零记录 */ }
  const constraintTraces = traces
    .filter(t => t && typeof t.timestamp === 'number' && t.timestamp >= sinceMs && t.timestamp <= untilMs && typeof t.constraintId === 'string');

  // D18: tool:call 与 knowledge:outcome 同一统一事件文件；兼容 payload 嵌套与历史扁平形态
  // #329: 整个扫描对该文件只读一次（原 toolCalls/outcomes 各读一遍，缓存命中仍重复全量 parse+filter）
  // #335: 窗口读口——窗口外的行不 parse；调用方侧窗口过滤保留（双保险，口径不变）
  const eventRows = await readStudioEventsSince({ file: paths.studioEventsFile, sinceMs }).catch(() => []);
  const toolCallRows = eventRows.filter(e => e && e.type === 'tool:call');
  const toolCalls: ToolCallEvent[] = [];
  for (const row of toolCallRows) {
    const p = parseStudioEventPayload(row) ?? {};
    const flat: Record<string, any> = { ...p, ...row };
    const ts = typeof flat.timestamp === 'number' ? flat.timestamp : getStudioEventTime(row);
    if (!Number.isFinite(ts) || ts < sinceMs || ts > untilMs) continue;
    toolCalls.push({
      type: 'tool:call',
      tool: flat.tool,
      success: flat.success,
      durationMs: flat.durationMs,
      timestamp: ts,
      caller: flat.caller,
      riskLevel: flat.riskLevel,
    });
  }

  const outcomeRows = eventRows
    .filter(r => r && typeof r.type === 'string' && r.type.startsWith('knowledge:outcome:')
      && typeof r.createdAt === 'string' && new Date(r.createdAt).getTime() >= sinceMs
      && new Date(r.createdAt).getTime() <= untilMs);

  const outcomes: OutcomeEvent[] = [];
  for (const row of outcomeRows) {
    try {
      const p = JSON.parse(String(row.payload ?? '{}'));
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
