// ─── workunit:tokens / tool:call 事件落盘（M2/B6/D18/T-1.1） ───
// 2026-08 工单 28 从 agent-loop.ts 原样抽出（行为不变）：
// workunit:tokens 事件写入（注入估算 vs CLI 真实 usage 诚实口径）+
// tool:call trace 落盘（PatternMiner 数据源）。
// agent-loop.ts re-export 保持对外导出语义不变。
import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { parseStreamEvents, extractToolCalls, parseSessionMetrics, FileStore } from '@dommaker/studio-shared';
import type { ExecutionResult } from '@dommaker/studio-agent';
import { noteTokensWritten } from './daily-token-budget.js';
import { resolveStudioEventsFile } from '../../utils/studio-events.js';

/** 事件落盘共享 FileStore（appendJsonl 写入用；agent-loop 的 skill 注入度量同用此实例） */
export const metricsFileStore = new FileStore();

export interface WorkunitTokenEventArgs {
  workUnitId: string;
  executionId?: string;
  /** 注入上下文估算 tokens（调用方按 chars/4 约定估算，与 estimateTokens 一致） */
  injectedTokens: number;
  /**
   * 非缓存执行 tokens（CLI usage input+output，不含 cache）。CLI 未回报 usage 时传 null ——
   * 聚合端据此把该事件排除在执行 tokens/开销比均值外（executionSource='unavailable'），不编造 0。
   * 口径警告：delegation-gate 树预算（TREE_TOKEN_BUDGET=400K）按本字段校准，禁止改成含 cache；
   * 账单/熔断口径看 billedTokens / totalTokens（2026-08-03 token-burn issue B6）。
   */
  executionTokens: number | null;
  /** LLM 提取 tokens（可选；R3 提取异步入库，通常由 knowledge:extraction 事件单独度量） */
  extractionTokens?: number;
  /** D16: CLI usage 的 input tokens（缓存命中率分子分母用；有 usage 时写入） */
  inputTokens?: number;
  /** B6: CLI usage 的 output tokens（此前只记 input/cache，输出无账） */
  outputTokens?: number;
  /** D16: CLI usage 的 cache read / creation tokens（缓存命中率用；有 usage 时写入） */
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** B6: 真实账单口径 = input+output+cacheRead+cacheCreation（有 usage 时写入） */
  billedTokens?: number;
  /** B6: CLI 回报的美元成本 / 轮数（modelUsage 可得时写入） */
  costUsd?: number;
  numTurns?: number;
  /** B6: 触发器来源（trigger 创建的 WU；按触发器聚合的输入） */
  triggerId?: string;
}

/** B6: 一次执行的真实 token 用量（账单口径，含 cache） */
export interface RealUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** input+output+cacheRead+cacheCreation —— 账单/预算熔断口径 */
  billedTokens: number;
  costUsd?: number;
  numTurns?: number;
}

/**
 * B6（2026-08-03 token-burn issue P1-2）：真实 usage 解析链。
 * 优先 modelUsage 累积（parseSessionMetrics 读 result 事件的 modelUsage.* —— 多轮会话全量；
 * 顶层 usage.* 仅最后一轮，extractUsage 只见到它，是此前 cache_read 无账的结构性原因之一）；
 * 兜底 runner 透出的 extractUsage 聚合（无 rawOutput 的失败路径）；全零 → null（不编造）。
 */
export function resolveRealUsage(result: ExecutionResult): RealUsage | null {
  if (result.rawOutput) {
    const m = parseSessionMetrics(result.rawOutput);
    if (m.tokenInput + m.tokenOutput + m.tokenCacheRead + m.tokenCacheWrite > 0) {
      return {
        inputTokens: m.tokenInput,
        outputTokens: m.tokenOutput,
        cacheReadTokens: m.tokenCacheRead,
        cacheCreationTokens: m.tokenCacheWrite,
        billedTokens: m.tokenInput + m.tokenOutput + m.tokenCacheRead + m.tokenCacheWrite,
        ...(m.costUsd ? { costUsd: m.costUsd } : {}),
        ...(m.numTurns ? { numTurns: m.numTurns } : {}),
      };
    }
  }
  const u = result.usage;
  if (u && u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens > 0) {
    return {
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadTokens,
      cacheCreationTokens: u.cacheCreationTokens,
      billedTokens: u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens,
    };
  }
  return null;
}

/**
 * M2: 写一条 workunit:tokens 事件（模块级函数，供 agent-loop 与单测直接调用）。
 * totalTokens = injectedTokens + (billedTokens ?? executionTokens ?? 0)
 * （B6：billed 含 cache 是账单口径；executionTokens 保持 input+output 旧语义供树预算闸门用）。
 */
export async function writeWorkunitTokenEvent(eventsFile: string, args: WorkunitTokenEventArgs): Promise<void> {
  const executionTokens = typeof args.executionTokens === 'number' && Number.isFinite(args.executionTokens)
    ? args.executionTokens
    : null;
  const billedTokens = typeof args.billedTokens === 'number' && Number.isFinite(args.billedTokens)
    ? args.billedTokens
    : null;
  await metricsFileStore.appendJsonl(eventsFile, {
    type: 'workunit:tokens',
    source: 'agent-loop',
    payload: JSON.stringify({
      workUnitId: args.workUnitId,
      executionId: args.executionId,
      injectedTokens: args.injectedTokens,
      injectedSource: 'estimate:chars/4',
      executionTokens,
      executionSource: executionTokens !== null || billedTokens !== null ? 'cli-usage' : 'unavailable',
      totalTokens: args.injectedTokens + (billedTokens ?? executionTokens ?? 0),
      ...(typeof args.extractionTokens === 'number' ? { extractionTokens: args.extractionTokens } : {}),
      ...(typeof args.inputTokens === 'number' ? { inputTokens: args.inputTokens } : {}),
      ...(typeof args.outputTokens === 'number' ? { outputTokens: args.outputTokens } : {}),
      ...(typeof args.cacheReadTokens === 'number' ? { cacheReadTokens: args.cacheReadTokens } : {}),
      ...(typeof args.cacheCreationTokens === 'number' ? { cacheCreationTokens: args.cacheCreationTokens } : {}),
      ...(billedTokens !== null ? { billedTokens } : {}),
      ...(typeof args.costUsd === 'number' ? { costUsd: args.costUsd } : {}),
      ...(typeof args.numTurns === 'number' ? { numTurns: args.numTurns } : {}),
      ...(args.triggerId ? { triggerId: args.triggerId } : {}),
    }),
    createdAt: new Date().toISOString(),
  });
  // C3: 进程内当日预算计数器累加（口径与熔断扫描一致 = billed ?? total），
  // 仅在落盘成功后计；未 bootstrap/跨天由 daily-token-budget 自重扫收敛。
  noteTokensWritten(eventsFile, billedTokens ?? (args.injectedTokens + (executionTokens ?? 0)));
}

// ─── tool:call event recording ───

/**
 * D18 事件入口统一: tool:call trace 写入统一事件文件
 * （~/.studio/logs/studio-events.jsonl，测试期经 studio-log-path 隔离）。
 * 懒解析以支持运行时/测试注入 env。
 */
export function resolveToolTraceFile(): string {
  return resolveStudioEventsFile();
}

/**
 * Write tool:call events extracted from stream-json output to a JSONL file.
 * Returns the count of tool calls written.
 * T-1.1: Wiring tool:call recording for PatternMiner data source.
 * D18: StudioEvent 形态（payload 嵌套），与 daemon/task-executor 的 tool:call 一致。
 */
export function writeToolCallEvents(outputText: string, filePath: string): number {
  const events = parseStreamEvents(outputText);
  const toolCalls = extractToolCalls(events);
  if (toolCalls.length === 0) return 0;

  const dir = filePath.substring(0, filePath.lastIndexOf('/'));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const now = Date.now();
  for (const call of toolCalls) {
    const event = JSON.stringify({
      type: 'tool:call',
      source: 'agent-loop',
      payload: JSON.stringify({
        tool: call.name,
        success: true,
        durationMs: 0,
        timestamp: now,
        caller: 'agent-loop',
      }),
      createdAt: new Date(now).toISOString(),
    });
    appendFileSync(filePath, event + '\n', 'utf-8');
  }

  return toolCalls.length;
}
