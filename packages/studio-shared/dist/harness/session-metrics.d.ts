/**
 * Session Metrics — parse claude --output-format json output into structured metrics.
 *
 * The Claude CLI --output-format json produces a JSON line with:
 *   usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens,
 *   usage.cache_creation_input_tokens, usage.service_tier,
 *   modelUsage.{model}.inputTokens etc., duration_ms, num_turns, total_cost_usd
 */
export interface SessionMetrics {
    /** Raw JSON if parseable, undefined if output wasn't valid JSON */
    tokenInput: number;
    tokenOutput: number;
    tokenCacheRead: number;
    tokenCacheWrite: number;
    durationMs: number;
    numTurns: number;
    costUsd: number;
    serviceTier: string;
    modelName: string;
    sessionId: string;
}
/**
 * Try to parse Claude CLI JSON output from stdout.
 * The last line of stdout should be a JSON object.
 * Returns structured metrics or defaults if unparseable.
 */
export declare function parseSessionMetrics(stdout: string): SessionMetrics;
/**
 * Estimate tokens from character count (rough: chars / 4).
 */
export declare function estimateTokens(chars: number): number;
//# sourceMappingURL=session-metrics.d.ts.map