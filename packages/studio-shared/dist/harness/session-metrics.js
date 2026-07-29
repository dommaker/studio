/**
 * Session Metrics — parse claude --output-format json output into structured metrics.
 *
 * The Claude CLI --output-format json produces a JSON line with:
 *   usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens,
 *   usage.cache_creation_input_tokens, usage.service_tier,
 *   modelUsage.{model}.inputTokens etc., duration_ms, num_turns, total_cost_usd
 */
const EMPTY_METRICS = {
    tokenInput: 0,
    tokenOutput: 0,
    tokenCacheRead: 0,
    tokenCacheWrite: 0,
    durationMs: 0,
    numTurns: 0,
    costUsd: 0,
    serviceTier: '',
    modelName: '',
    sessionId: '',
};
/**
 * Try to parse Claude CLI JSON output from stdout.
 * The last line of stdout should be a JSON object.
 * Returns structured metrics or defaults if unparseable.
 */
export function parseSessionMetrics(stdout) {
    const lines = stdout.trim().split('\n');
    // Find the last JSON line (Claude may output thinking/progress before the final JSON)
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line.startsWith('{')) {
            try {
                const raw = JSON.parse(line);
                return extractMetrics(raw);
            }
            catch {
                // not valid JSON, try next line
            }
        }
    }
    return { ...EMPTY_METRICS };
}
function extractMetrics(raw) {
    const usage = (raw.usage || {});
    const modelUsage = (raw.modelUsage || {});
    const modelNames = Object.keys(modelUsage);
    // Primary model = first key (for modelName only)
    const modelName = modelNames[0] || '';
    // Sum token counts across ALL models in modelUsage.
    // usage.* only reflects the LAST API call in a multi-turn session,
    // while modelUsage.* accumulates across all turns and all models.
    let muInput = 0, muOutput = 0, muCacheRead = 0, muCacheWrite = 0;
    for (const m of modelNames) {
        const d = modelUsage[m] || {};
        muInput += d.inputTokens || 0;
        muOutput += d.outputTokens || 0;
        muCacheRead += d.cacheReadInputTokens || 0;
        muCacheWrite += d.cacheCreationInputTokens || 0;
    }
    return {
        tokenInput: muInput || usage.input_tokens || 0,
        tokenOutput: muOutput || usage.output_tokens || 0,
        tokenCacheRead: muCacheRead || usage.cache_read_input_tokens || 0,
        tokenCacheWrite: muCacheWrite || usage.cache_creation_input_tokens || 0,
        durationMs: raw.duration_ms || 0,
        numTurns: raw.num_turns || 0,
        costUsd: raw.total_cost_usd || 0,
        serviceTier: usage.service_tier || '',
        modelName,
        sessionId: raw.session_id || '',
    };
}
/**
 * Estimate tokens from character count (rough: chars / 4).
 */
export function estimateTokens(chars) {
    return Math.ceil(chars / 4);
}
//# sourceMappingURL=session-metrics.js.map