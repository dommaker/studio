/**
 * Stream-JSON Parser — 解析 Claude CLI --output-format stream-json 输出
 *
 * D2: 提取 stream-json 解析逻辑到共享模块，供 agent-runner 和 daemon session-manager 使用。
 */

export interface StreamEvent {
  type: string;
  subtype?: string;
  content?: Array<{ type: string; name?: string; input?: unknown; text?: string }>;
  message?: { content?: Array<{ type: string; name?: string; input?: unknown }> };
  result?: string;
  is_error?: boolean;
  usage?: Record<string, unknown>;
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
