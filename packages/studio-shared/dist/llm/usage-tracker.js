/**
 * Usage Tracker — token/cost 用量统计
 *
 * P11-06: Extracted from model-gateway.ts
 */
const MAX_LOG_SIZE = 10000;
/**
 * 记录用量
 */
export function recordUsage(log, record) {
    log.push(record);
    if (log.length > MAX_LOG_SIZE) {
        return log.slice(-MAX_LOG_SIZE / 2);
    }
    return log;
}
/**
 * 获取用量统计
 */
export function getStats(usageLog) {
    const byProvider = {};
    for (const record of usageLog) {
        if (!byProvider[record.provider]) {
            byProvider[record.provider] = { calls: 0, successes: 0, totalTokens: 0, avgLatencyMs: 0, avgQualityScore: 0 };
        }
        const p = byProvider[record.provider];
        p.calls++;
        if (record.success)
            p.successes++;
        p.totalTokens += record.totalTokens;
        p.avgLatencyMs = Math.round((p.avgLatencyMs * (p.calls - 1) + record.latencyMs) / p.calls);
        if (record.qualityScore !== undefined) {
            p.avgQualityScore = Math.round((p.avgQualityScore * (p.calls - 1) + record.qualityScore) / p.calls);
        }
    }
    const totalCalls = usageLog.length;
    const successes = usageLog.filter(r => r.success).length;
    const qualityScores = usageLog.filter(r => r.qualityScore !== undefined).map(r => r.qualityScore);
    return {
        totalCalls,
        successRate: totalCalls > 0 ? Math.round((successes / totalCalls) * 100) : 0,
        avgLatencyMs: totalCalls > 0
            ? Math.round(usageLog.reduce((sum, r) => sum + r.latencyMs, 0) / totalCalls)
            : 0,
        totalTokens: usageLog.reduce((sum, r) => sum + r.totalTokens, 0),
        avgQualityScore: qualityScores.length > 0
            ? Math.round(qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length)
            : 0,
        byProvider,
    };
}
/**
 * 获取最近 N 条调用记录
 */
export function getRecentUsage(usageLog, n = 50) {
    return usageLog.slice(-n);
}
/**
 * 质量评分
 */
export function scoreQuality(content, finishReason, latencyMs) {
    let score = 50; // 基础分
    // 响应长度合理性（太短扣分，适中加分）
    if (content.length > 100)
        score += 15;
    else if (content.length > 20)
        score += 10;
    else if (content.length < 5)
        score -= 20;
    // finish_reason = stop 为正常结束
    if (finishReason === 'stop')
        score += 15;
    else if (finishReason === 'length')
        score -= 10;
    // 延迟评分（<2s 优，<5s 良，>10s 差）
    if (latencyMs < 2000)
        score += 20;
    else if (latencyMs < 5000)
        score += 10;
    else if (latencyMs > 10000)
        score -= 15;
    return Math.max(0, Math.min(100, score));
}
//# sourceMappingURL=usage-tracker.js.map