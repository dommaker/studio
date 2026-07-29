/**
 * Stream-JSON Parser — 解析 Claude CLI --output-format stream-json 输出
 *
 * D2: 提取 stream-json 解析逻辑到共享模块，供 agent-runner 和 daemon session-manager 使用。
 */
export interface StreamEvent {
    type: string;
    subtype?: string;
    content?: Array<{
        type: string;
        name?: string;
        input?: unknown;
        text?: string;
    }>;
    message?: {
        content?: Array<{
            type: string;
            name?: string;
            input?: unknown;
        }>;
    };
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
export declare function parseStreamEvents(stdout: string): StreamEvent[];
/**
 * Extract tool_use blocks from stream events.
 */
export declare function extractToolCalls(events: StreamEvent[]): ToolCall[];
/**
 * Extract file path from tool input for file:change tracking.
 */
export declare function extractFilePath(toolName: string, input: unknown): string | null;
/**
 * Parse a single stream-json line into a StreamEvent.
 * Returns null for non-JSON or empty lines.
 * Used by streaming consumers that process lines as they arrive.
 */
export declare function parseStreamLine(line: string): StreamEvent | null;
/**
 * Extract aggregated token usage from stream events.
 *
 * Stream-json events may carry `usage` on assistant/result events.
 * This function sums across all events to get total token counts.
 */
export declare function extractUsage(events: StreamEvent[]): {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    model: string;
};
/**
 * Extract the final text result from stream events.
 */
export declare function extractResult(events: StreamEvent[]): {
    text: string;
    isError: boolean;
};
/**
 * Extract the last Write tool_use content for a specific file path.
 * Used for output file recovery when the file is missing from disk.
 * Returns null if no matching Write event found.
 */
export declare function extractWriteContent(events: StreamEvent[], targetPath: string): string | null;
//# sourceMappingURL=stream-json-parser.d.ts.map