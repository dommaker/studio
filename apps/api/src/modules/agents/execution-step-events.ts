/**
 * 执行步事件（WU 过程可视化，Layer A 步级粒度）
 *
 * 背景：agent step 执行期间（CLI 跑着的几分钟）系统零可见性——rawOutput（stream-json
 * 全量 stdout）只在进程结束后被解析成 tool:call/token 度量，thinking 块无人消费。
 * 本模块在每个 step 结束后把本步产出提炼成一条 `workunit:execution_step` 事件：
 *   1. 落盘 studio-events.jsonl（writeStudioEvent）——REST 回放数据源
 *      （GET /api/v1/events?type=workunit:execution_step&workUnitId=<id>）；
 *   2. 经 eventStore.publish 发 SSE 信封 `workunit.execution.step`——`workunit.` 前缀
 *      自动落入 workunits topic（sse.routes 纯前缀映射，SSE 链路零改动）。
 *
 * 定位约束（决策）：频道是协作记录只留里程碑，过程可视化属于 WU 详情抽屉——
 * 本事件不进频道、不写 WU metadata（防膨胀），只走事件流。
 * fire-and-forget：解析/写盘/发布任何失败只记日志，绝不影响任务流程。
 *
 * 容量纪律：thinking ≤3 条 ×500 字符；toolCalls ≤30 条 ×160 字符摘要；text ≤500 字符。
 * 完整 transcript 需要时按 claude projects 文件回放（见 agents/CONTEXT.md），不在这里复制。
 */

import { parseStreamEvents, extractToolCalls, extractUsage, logger, type StreamEvent } from '@dommaker/studio-shared';
import { v4 as uuidv4 } from 'uuid';
import { eventStore } from '../../core/event-store.js';
import { writeStudioEvent } from '../../utils/studio-events.js';

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
  /** 1 基步号（调用方按 metadata.stepCount+1 计） */
  step: number;
  /** 本步 ACTION 结论（progress/complete/need_input/failed） */
  action?: string;
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
  step: number;
  action?: string;
  /** stream-json 全量 stdout（result.rawOutput）；空/不可解析 → 返回 null */
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

  if (thinking.length === 0 && toolCalls.length === 0 && !text && !hasUsage && skills.length === 0) {
    return null;
  }

  return {
    workUnitId: args.workUnitId,
    executionId: args.executionId,
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    step: args.step,
    ...(args.action ? { action: args.action } : {}),
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
