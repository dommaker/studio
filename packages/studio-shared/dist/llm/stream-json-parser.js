/**
 * Stream-JSON Parser — 解析 Claude CLI --output-format stream-json 输出
 *
 * D2: 提取 stream-json 解析逻辑到共享模块，供 agent-runner 和 daemon session-manager 使用。
 */
import * as path from 'path';
/**
 * Parse stream-json stdout into structured events.
 * Each line is a JSON object with { type, subtype?, content?, ... }
 */
export function parseStreamEvents(stdout) {
    const events = [];
    for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('{'))
            continue;
        try {
            events.push(JSON.parse(trimmed));
        }
        catch { /* skip non-JSON lines */ }
    }
    return events;
}
/**
 * Extract tool_use blocks from stream events.
 */
export function extractToolCalls(events) {
    const tools = [];
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
export function extractFilePath(toolName, input) {
    if (!input || typeof input !== 'object')
        return null;
    const inp = input;
    if (toolName === 'Write' || toolName === 'Edit' || toolName === 'write' || toolName === 'edit') {
        return inp.file_path || inp.path || null;
    }
    return null;
}
/**
 * Parse a single stream-json line into a StreamEvent.
 * Returns null for non-JSON or empty lines.
 * Used by streaming consumers that process lines as they arrive.
 */
export function parseStreamLine(line) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{'))
        return null;
    try {
        return JSON.parse(trimmed);
    }
    catch {
        return null;
    }
}
/**
 * Extract aggregated token usage from stream events.
 *
 * Stream-json events may carry `usage` on assistant/result events.
 * This function sums across all events to get total token counts.
 */
export function extractUsage(events) {
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let model = '';
    for (const event of events) {
        const u = event.usage;
        if (!u)
            continue;
        inputTokens += u.input_tokens || 0;
        outputTokens += u.output_tokens || 0;
        cacheReadTokens += u.cache_read_input_tokens || 0;
        cacheCreationTokens += u.cache_creation_input_tokens || 0;
        if (!model && u.model)
            model = u.model;
    }
    return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, model };
}
/**
 * Extract the final text result from stream events.
 */
export function extractResult(events) {
    let text = '';
    let isError = false;
    for (const event of events) {
        if (event.type === 'result') {
            if (event.is_error)
                isError = true;
            if (event.result)
                text = event.result;
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
export function extractWriteContent(events, targetPath) {
    const normalized = path.resolve(targetPath);
    let lastContent = null;
    for (const event of events) {
        const calls = extractToolCalls([event]);
        for (const call of calls) {
            if (call.name !== 'Write' && call.name !== 'write')
                continue;
            const fp = extractFilePath(call.name, call.input);
            if (!fp)
                continue;
            if (path.resolve(fp) !== normalized)
                continue;
            const inp = call.input;
            if (typeof inp.content === 'string') {
                lastContent = inp.content;
            }
        }
    }
    return lastContent;
}
//# sourceMappingURL=stream-json-parser.js.map