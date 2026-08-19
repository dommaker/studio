/**
 * Stream-JSON Parser — 解析 Claude CLI --output-format stream-json 输出
 *
 * D2: 提取 stream-json 解析逻辑到共享模块，供 agent-runner 和 daemon session-manager 使用。
 */

import * as path from 'path';

export interface StreamEvent {
  type: string;
  subtype?: string;
  content?: StreamContentBlock[];
  message?: { content?: StreamContentBlock[] };
  result?: string;
  is_error?: boolean;
  usage?: Record<string, unknown>;
}

/** stream-json 内容块：thinking/text/tool_use（assistant）与 tool_result（user）两类载体共用 */
export interface StreamContentBlock {
  type: string;
  /** tool_use 块 id（#240：tool/tool-result 配对锚点） */
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
  /** tool_result 块：回指 tool_use.id */
  tool_use_id?: string;
  is_error?: boolean;
  /** tool_result 块内容（string 或 {type,text}[]） */
  content?: unknown;
}

export interface ToolCall {
  name: string;
  input: unknown;
}

/**
 * Parse stream-json stdout into structured events.
 * Each line is a JSON object with { type, subtype?, content?, ... }
 */
export function parseStreamEvents(stdout: string): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch { /* skip non-JSON lines */ }
  }
  return events;
}

/**
 * Extract tool_use blocks from stream events.
 */
export function extractToolCalls(events: StreamEvent[]): ToolCall[] {
  const tools: ToolCall[] = [];
  for (const event of events) {
    // Direct content array
    if (event.content && Array.isArray(event.content)) {
      for (const block of event.content) {
        if (block.type === 'tool_use' && block.name) {
          tools.push({ name: block.name, input: block.input });
        }
      }
    }
    // message.content format (assistant messages)
    if (event.message?.content && Array.isArray(event.message.content)) {
      for (const block of event.message.content) {
        if (block.type === 'tool_use' && block.name) {
          tools.push({ name: block.name, input: block.input });
        }
      }
    }
  }
  return tools;
}

/**
 * Extract file path from tool input for file:change tracking.
 */
export function extractFilePath(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const inp = input as Record<string, unknown>;
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'write' || toolName === 'edit') {
    return (inp.file_path as string) || (inp.path as string) || null;
  }
  return null;
}

/**
 * Parse a single stream-json line into a StreamEvent.
 * Returns null for non-JSON or empty lines.
 * Used by streaming consumers that process lines as they arrive.
 */
export function parseStreamLine(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{')) return null;
  try {
    return JSON.parse(trimmed) as StreamEvent;
  } catch {
    return null;
  }
}

/**
 * Extract aggregated token usage from stream events.
 *
 * Stream-json events may carry `usage` on assistant/result events.
 * This function sums across all events to get total token counts.
 */
export function extractUsage(events: StreamEvent[]): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  model: string;
} {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let model = '';

  for (const event of events) {
    const u = event.usage as Record<string, unknown> | undefined;
    if (!u) continue;
    inputTokens += (u.input_tokens as number) || 0;
    outputTokens += (u.output_tokens as number) || 0;
    cacheReadTokens += (u.cache_read_input_tokens as number) || 0;
    cacheCreationTokens += (u.cache_creation_input_tokens as number) || 0;
    if (!model && u.model) model = u.model as string;
  }

  return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, model };
}

/**
 * Extract the final text result from stream events.
 */
export function extractResult(events: StreamEvent[]): { text: string; isError: boolean } {
  let text = '';
  let isError = false;
  for (const event of events) {
    if (event.type === 'result') {
      if (event.is_error) isError = true;
      if (event.result) text = event.result;
    }
    if (event.type === 'assistant' && event.content) {
      for (const block of event.content) {
        if (block.type === 'text' && block.text) {
          text += block.text;
        }
      }
    }
  }
  return { text, isError };
}

/**
 * Extract the last Write tool_use content for a specific file path.
 * Used for output file recovery when the file is missing from disk.
 * Returns null if no matching Write event found.
 */
export function extractWriteContent(events: StreamEvent[], targetPath: string): string | null {
  const normalized = path.resolve(targetPath);
  let lastContent: string | null = null;

  for (const event of events) {
    const calls = extractToolCalls([event]);
    for (const call of calls) {
      if (call.name !== 'Write' && call.name !== 'write') continue;
      const fp = extractFilePath(call.name, call.input);
      if (!fp) continue;
      if (path.resolve(fp) !== normalized) continue;
      const inp = call.input as Record<string, unknown>;
      if (typeof inp.content === 'string') {
        lastContent = inp.content;
      }
    }
  }

  return lastContent;
}
