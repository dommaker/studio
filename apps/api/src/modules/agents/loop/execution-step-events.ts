/**
 * 执行步事件（WU 过程可视化）
 *
 * Layer A（步级粒度）：agent step 执行期间（CLI 跑着的几分钟）系统零可见性——
 * rawOutput（stream-json 全量 stdout）只在进程结束后被解析成 tool:call/token 度量，
 * thinking 块无人消费。本模块在每个 step 结束后把本步产出提炼成一条
 * `workunit:execution_step` 事件：
 *   1. 落盘 studio-events.jsonl（writeStudioEvent）——REST 回放数据源
 *      （GET /api/v1/events?type=workunit:execution_step&workUnitId=<id>）；
 *   2. 经 eventStore.publish 发 SSE 信封 `workunit.execution.step`——`workunit.` 前缀
 *      自动落入 workunits topic（sse.routes 纯前缀映射，SSE 链路零改动）。
 *
 * Layer B（步内流式）：execSh onLine 把 CLI stdout 按行透传（runner-lightweight 接线），
 * 每行提炼成 0..n 个轻量 chunk 经 SSE `workunit.execution.stream` 实时推出——
 * **只发 SSE，不落盘**（行级体量落盘会撑爆事件流；步级归档由 Layer A 负责）。
 * step-start 由 agent-loop 在 spawn 前合成（provider 无关的执行开始信号）。
 *
 * 定位约束（决策）：频道是协作记录只留里程碑，过程可视化属于 WU 详情抽屉——
 * 本事件不进频道、不写 WU metadata（防膨胀），只走事件流。
 * fire-and-forget：解析/写盘/发布任何失败只记日志，绝不影响任务流程。
 *
 * #172（#60 决策 Q1）结构化失败事件：
 *   - execution_step payload 加 status: 'success'|'failed' + errorType/errorDetail；
 *     失败步（CLI success:false / 异常）也落盘——此前失败分支提前 return 到不了发射点，
 *     失败步在事件流中完全不可查。失败步无任何可解析内容也产事件（失败信号不落空）。
 *   - 新增 workunit:failed（WU 级终态失败，转 blocked 时落盘，envelope level=warning）：
 *     payload = workUnitId / failureType / blockReason / consecutiveStuck / attempts /
 *     totalDurationMs / traceId（traceId 与 audit.jsonl 的 requestId 同值，打通审计侧）。
 *     #62 的 WU 失败趋势探测直接读它。
 *
 * 容量纪律：thinking ≤3 条 ×500 字符；toolCalls ≤30 条 ×160 字符摘要；text ≤500 字符；
 * stream chunk 单条 ≤500 字符、单行 ≤10 条、前端只留当前步。
 * 完整 transcript 需要时按 claude projects 文件回放（见 .studio/CONTEXT.md 的 apps/api/src/modules/agents 锚点），不在这里复制。
 */

import { parseStreamEvents, parseStreamLine, extractToolCalls, extractUsage, logger, type StreamEvent } from '@dommaker/studio-shared';
import { v4 as uuidv4 } from 'uuid';
import { eventStore } from '../../../core/event-store.js';
import { writeStudioEvent } from '../../../utils/studio-events.js';

export const EXECUTION_STEP_EVENT_TYPE = 'workunit:execution_step';
/** SSE 信封的 event_type（workunit. 前缀 → workunits topic） */
export const EXECUTION_STEP_SSE_TYPE = 'workunit.execution.step';

const THINKING_MAX_ENTRIES = 3;
const THINKING_MAX_CHARS = 500;
const TOOLCALLS_MAX_ENTRIES = 30;
const TOOLCALL_SUMMARY_CHARS = 160;
const TEXT_MAX_CHARS = 500;

export interface ExecutionStepToolCall {
  tool: string;
  /** 面向人读的输入摘要：Read/Edit/Write→file_path；Bash→command；Glob/Grep→pattern；其余 JSON 截断 */
  summary: string;
}

export interface ExecutionStepEventPayload {
  workUnitId: string;
  executionId: string;
  sessionId?: string;
  /** #94: 本步会话续用(true)/新建(false) 标记（内部状态，不上频道；缺省 = 调用方未提供） */
  sessionResumed?: boolean;
  /** 1 基步号（调用方按 metadata.stepCount+1 计） */
  step: number;
  /** 本步 ACTION 结论（progress/complete/need_input/failed） */
  action?: string;
  /** #172（#60 决策 Q1）：本步成败（缺省 success；失败步携带 errorType/errorDetail） */
  status: 'success' | 'failed';
  /** #172: 失败步错误分类（execution_failed / worktree_creation_failed 等，同 metadata.errorType 口径） */
  errorType?: string;
  /** #172: 失败步错误详情（截断，同 recordOutcomeEvent 口径） */
  errorDetail?: string;
  thinking: string[];
  toolCalls: ExecutionStepToolCall[];
  /** 本步注入的 skill 名单（= 本步 metadata.matchedSkills 落盘值） */
  skills: string[];
  /** assistant 文本输出摘要（截断） */
  text?: string;
  usage?: { inputTokens: number; outputTokens: number; model?: string };
  at: string;
}

export interface BuildExecutionStepEventArgs {
  workUnitId: string;
  executionId: string;
  sessionId?: string;
  /** #94: 本步会话续用(true)/新建(false) 标记（undefined 时 payload 不产该键） */
  sessionResumed?: boolean;
  step: number;
  action?: string;
  /** #172: 缺省 'success'；'failed' 时无有效内容也产事件（失败信号不落空） */
  status?: 'success' | 'failed';
  /** #172: status='failed' 时的错误分类/详情（截断 500 字符） */
  errorType?: string;
  errorDetail?: string;
  /** stream-json 全量 stdout（result.rawOutput）；空/不可解析 → 返回 null（status='failed' 除外） */
  rawOutput?: string | null;
  skills?: string[];
  at?: string;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 工具输入 → 单行摘要（面向人读，不存全量 input——全量可查 claude transcript） */
export function summarizeToolInput(tool: string, input: unknown): string {
  if (input && typeof input === 'object') {
    const inp = input as Record<string, unknown>;
    const pick = (...keys: string[]): string | null => {
      for (const k of keys) {
        if (typeof inp[k] === 'string' && (inp[k] as string).length > 0) return inp[k] as string;
      }
      return null;
    };
    let detail: string | null = null;
    if (tool === 'Read' || tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') {
      detail = pick('file_path', 'path');
    } else if (tool === 'Bash') {
      detail = pick('command');
    } else if (tool === 'Glob' || tool === 'Grep') {
      detail = pick('pattern');
    } else if (tool === 'Task' || tool === 'Agent') {
      detail = pick('description', 'prompt');
    } else if (tool === 'WebFetch' || tool === 'WebSearch') {
      detail = pick('url', 'query');
    }
    if (detail) return truncate(detail.replace(/\s+/g, ' ').trim(), TOOLCALL_SUMMARY_CHARS);
    try {
      return truncate(JSON.stringify(input), TOOLCALL_SUMMARY_CHARS);
    } catch { /* fall through */ }
  }
  return '';
}

/** thinking 块提取（content / message.content 两种载体；文本字段 thinking 优先、text 兜底） */
export function extractThinking(events: StreamEvent[]): string[] {
  const out: string[] = [];
  const walk = (blocks: Array<Record<string, unknown>> | undefined) => {
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      if (block?.type !== 'thinking') continue;
      const text = typeof block.thinking === 'string'
        ? block.thinking
        : typeof block.text === 'string' ? block.text : '';
      const trimmed = text.trim();
      if (trimmed) out.push(truncate(trimmed, THINKING_MAX_CHARS));
    }
  };
  for (const event of events) {
    walk(event.content as Array<Record<string, unknown>> | undefined);
    walk(event.message?.content as Array<Record<string, unknown>> | undefined);
    if (out.length >= THINKING_MAX_ENTRIES) break;
  }
  return out.slice(0, THINKING_MAX_ENTRIES);
}

/** assistant 文本摘要（拼接 text 块 + result 事件最终文本，截断；ACTION 协议行通常在 result 里） */
export function extractTextSummary(events: StreamEvent[]): string {
  let text = '';
  for (const event of events) {
    const blocks = (event.content ?? event.message?.content) as Array<{ type?: string; text?: string }> | undefined;
    if (Array.isArray(blocks)) {
      for (const block of blocks) {
        if (block?.type === 'text' && typeof block.text === 'string') text += block.text;
      }
    }
    if (event.type === 'result' && typeof event.result === 'string') {
      text += (text ? '\n' : '') + event.result;
    }
  }
  return truncate(text.trim(), TEXT_MAX_CHARS);
}

/**
 * 提炼一步的执行事件（纯函数，可测）。
 * 无任何有效内容（无 thinking/toolCalls/text/usage/skills）→ null（不产生空信号事件）。
 * #172: status='failed' 除外——失败本身就是信号，无内容也产事件（失败步落盘决策）。
 */
export function buildExecutionStepEvent(args: BuildExecutionStepEventArgs): ExecutionStepEventPayload | null {
  const events = typeof args.rawOutput === 'string' && args.rawOutput.trim().length > 0
    ? parseStreamEvents(args.rawOutput)
    : [];
  const thinking = extractThinking(events);
  const toolCalls = extractToolCalls(events)
    .slice(0, TOOLCALLS_MAX_ENTRIES)
    .map(c => ({ tool: c.name, summary: summarizeToolInput(c.name, c.input) }));
  const text = extractTextSummary(events);
  const usage = extractUsage(events);
  const hasUsage = usage.inputTokens + usage.outputTokens > 0;
  const skills = (args.skills ?? []).filter(s => typeof s === 'string' && s.length > 0);
  const status = args.status ?? 'success';

  if (status !== 'failed'
    && thinking.length === 0 && toolCalls.length === 0 && !text && !hasUsage && skills.length === 0) {
    return null;
  }

  return {
    workUnitId: args.workUnitId,
    executionId: args.executionId,
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    ...(args.sessionResumed !== undefined ? { sessionResumed: args.sessionResumed } : {}),
    step: args.step,
    ...(args.action ? { action: args.action } : {}),
    status,
    ...(status === 'failed' && args.errorType ? { errorType: args.errorType } : {}),
    ...(status === 'failed' && args.errorDetail ? { errorDetail: truncate(args.errorDetail, TEXT_MAX_CHARS) } : {}),
    thinking,
    toolCalls,
    skills,
    ...(text ? { text } : {}),
    ...(hasUsage
      ? { usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, ...(usage.model ? { model: usage.model } : {}) } }
      : {}),
    at: args.at ?? new Date().toISOString(),
  };
}

/**
 * 发布执行步事件：落盘（REST 回放）+ SSE（实时推送）。永不抛出。
 * 返回是否产生了事件（null 内容/写盘失败均返回 false，仅作观测）。
 */
export async function emitExecutionStepEvent(args: BuildExecutionStepEventArgs): Promise<boolean> {
  try {
    const payload = buildExecutionStepEvent(args);
    if (!payload) return false;
    await writeStudioEvent(EXECUTION_STEP_EVENT_TYPE, payload, { source: 'agent-loop' });
    await eventStore.publish('events', JSON.stringify({
      event_type: EXECUTION_STEP_SSE_TYPE,
      event_id: uuidv4(),
      timestamp: payload.at,
      data: payload,
    })).catch(() => {}); // best-effort，与 agent.health.failed 同一形态
    return true;
  } catch (err) {
    logger.warn('[ExecutionStepEvent] emit failed', { workUnitId: args.workUnitId, error: String(err) });
    return false;
  }
}

// ─── #172（#60 决策 Q1）：workunit:failed —— WU 级终态失败事件 ───

export const WORKUNIT_FAILED_EVENT_TYPE = 'workunit:failed';

/**
 * WU 级终态失败 payload（决策字段）：
 * traceId 与 audit.jsonl 的 requestId 同值（打通审计侧）；#62 失败趋势探测直接读本事件。
 */
export interface WorkUnitFailedEventPayload {
  workUnitId: string;
  /** 失败分类：verify_failed（自动验证连续失败）/ execution_failed 等 metadata.errorType / stuck（连续无进展） */
  failureType: string;
  /** 落盘到 metadata.blockReason 的同一文本 */
  blockReason: string;
  consecutiveStuck: number;
  /** 已执行步数（metadata.stepCount 口径） */
  attempts: number;
  /** WU 创建 → 转 blocked 的总耗时 */
  totalDurationMs: number;
  traceId?: string;
}

/**
 * WU 转 blocked（终态失败）时落盘 workunit:failed，envelope level=warning（#60 决策 Q2）。
 * 只落盘不进频道（频道里程碑由 recordResult 既有 postToDiscussionSpace 负责）。
 * fire-and-forget：写盘失败只记日志，绝不影响状态迁移。
 */
export async function emitWorkUnitFailedEvent(payload: WorkUnitFailedEventPayload): Promise<boolean> {
  try {
    return await writeStudioEvent(WORKUNIT_FAILED_EVENT_TYPE, {
      workUnitId: payload.workUnitId,
      failureType: payload.failureType,
      blockReason: payload.blockReason,
      consecutiveStuck: payload.consecutiveStuck,
      attempts: payload.attempts,
      totalDurationMs: payload.totalDurationMs,
      ...(payload.traceId ? { traceId: payload.traceId } : {}),
    }, { source: 'agent-loop', level: 'warning' });
  } catch (err) {
    logger.warn('[WorkUnitFailed] emit failed', { workUnitId: payload.workUnitId, error: String(err) });
    return false;
  }
}

// ─── Layer B：步内流式 chunk（SSE-only，不落盘） ───

/** SSE 信封的 event_type（workunit. 前缀 → workunits topic） */
export const EXECUTION_STREAM_SSE_TYPE = 'workunit.execution.stream';

const STREAM_TEXT_MAX_CHARS = 500;
const MAX_CHUNKS_PER_LINE = 10;

export type ExecutionStreamChunkKind = 'step-start' | 'thinking' | 'text' | 'tool' | 'tool-result' | 'result';

export interface ExecutionStreamChunk {
  workUnitId: string;
  executionId: string;
  /** 1 基步号（与 Layer A 执行步事件同口径） */
  step: number;
  kind: ExecutionStreamChunkKind;
  /** thinking/text/result/tool-result 文本（截断）；step-start/tool 时缺省 */
  text?: string;
  /** kind=tool 的工具名 + 人读摘要 */
  tool?: string;
  summary?: string;
  /** #240: tool/tool-result 配对锚点（tool_use.id ↔ tool_result.tool_use_id） */
  toolUseId?: string;
  /** kind=result 且 CLI 标 is_error；kind=tool-result 且工具报错 */
  isError?: boolean;
  at: string;
}

export interface BuildStreamChunksArgs {
  workUnitId: string;
  executionId: string;
  step: number;
  /** 单行 stream-json（execSh onLine 透传的原始行） */
  line: string;
  at?: string;
}

/**
 * 单行 stream-json → 0..n 个轻量 chunk（纯函数，可测）。
 * 只提炼面向人读的最小信息（thinking/text 截断、tool 人读摘要）；
 * system/progress 等事件跳过（降噪），非 JSON 行 → []。
 * #240：tool_use 块带 toolUseId；user(tool_result) 提炼为 tool-result chunk
 * （toolUseId 配对 + isError + 文本扁平化），支撑前端工具行四态推导；
 * 缺 tool_use_id 的 tool_result 无法配对 → 跳过。
 * result 恒产一条（空文本也产——它是「本回合结束」信号，供前端停掉实时指示）。
 */
export function buildExecutionStreamChunks(args: BuildStreamChunksArgs): ExecutionStreamChunk[] {
  const event = parseStreamLine(args.line);
  if (!event) return [];
  const base = {
    workUnitId: args.workUnitId,
    executionId: args.executionId,
    step: args.step,
    at: args.at ?? new Date().toISOString(),
  };
  const out: ExecutionStreamChunk[] = [];

  if (event.type === 'assistant') {
    const blocks = (event.message?.content ?? event.content) as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(blocks)) return [];
    for (const block of blocks) {
      if (out.length >= MAX_CHUNKS_PER_LINE) break;
      if (block?.type === 'thinking') {
        const t = (typeof block.thinking === 'string'
          ? block.thinking
          : typeof block.text === 'string' ? block.text : '').trim();
        if (t) out.push({ ...base, kind: 'thinking', text: truncate(t, STREAM_TEXT_MAX_CHARS) });
      } else if (block?.type === 'text') {
        const t = (typeof block.text === 'string' ? block.text : '').trim();
        if (t) out.push({ ...base, kind: 'text', text: truncate(t, STREAM_TEXT_MAX_CHARS) });
      } else if (block?.type === 'tool_use' && typeof block.name === 'string') {
        out.push({
          ...base,
          kind: 'tool',
          tool: block.name,
          summary: summarizeToolInput(block.name, block.input),
          ...(typeof block.id === 'string' && block.id ? { toolUseId: block.id } : {}),
        });
      }
    }
  } else if (event.type === 'user') {
    const blocks = (event.message?.content ?? event.content) as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(blocks)) return [];
    for (const block of blocks) {
      if (out.length >= MAX_CHUNKS_PER_LINE) break;
      if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string' || !block.tool_use_id) continue;
      const text = flattenToolResultText(block.content);
      out.push({
        ...base,
        kind: 'tool-result',
        toolUseId: block.tool_use_id,
        ...(block.is_error === true ? { isError: true } : {}),
        ...(text ? { text: truncate(text, STREAM_TEXT_MAX_CHARS) } : {}),
      });
    }
  } else if (event.type === 'result') {
    const t = typeof event.result === 'string' ? event.result.trim() : '';
    out.push({
      ...base,
      kind: 'result',
      ...(t ? { text: truncate(t, STREAM_TEXT_MAX_CHARS) } : {}),
      ...(event.is_error ? { isError: true } : {}),
    });
  }
  return out;
}

/** tool_result 块内容 → 单行文本（string 原样；块数组取 text 块拼接，其余 JSON；空 → ''） */
function flattenToolResultText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
        && typeof (block as { text?: unknown }).text === 'string') {
        parts.push((block as { text: string }).text);
      }
    }
    return parts.join('\n').trim();
  }
  return '';
}

/** SSE 逐条发布（只发 SSE，不落盘；单条失败不影响后续） */
async function publishStreamChunks(chunks: ExecutionStreamChunk[]): Promise<void> {
  for (const chunk of chunks) {
    await eventStore.publish('events', JSON.stringify({
      event_type: EXECUTION_STREAM_SSE_TYPE,
      event_id: uuidv4(),
      timestamp: chunk.at,
      data: chunk,
    })).catch(() => {}); // best-effort，与 Layer A 同一形态
  }
}

/** 步内单行透传：提炼 + SSE（fire-and-forget，任何失败只记日志，绝不影响任务流程） */
export async function emitExecutionStreamLine(args: BuildStreamChunksArgs): Promise<void> {
  try {
    const chunks = buildExecutionStreamChunks(args);
    if (chunks.length === 0) return;
    await publishStreamChunks(chunks);
  } catch (err) {
    logger.warn('[ExecutionStream] emit failed', { workUnitId: args.workUnitId, error: String(err) });
  }
}

/** step 开始信号（provider 无关——CLI 首行到达前抽屉即有反馈） */
export async function emitExecutionStreamStepStart(args: {
  workUnitId: string;
  executionId: string;
  step: number;
  at?: string;
}): Promise<void> {
  try {
    await publishStreamChunks([{
      workUnitId: args.workUnitId,
      executionId: args.executionId,
      step: args.step,
      kind: 'step-start',
      at: args.at ?? new Date().toISOString(),
    }]);
  } catch { /* non-blocking */ }
}
