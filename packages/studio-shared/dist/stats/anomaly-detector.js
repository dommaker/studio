// ============================================================
// 均值和标准差
// ============================================================
/**
 * 计算数组的均值和标准差（总体标准差）
 * @param values - 数值数组，空数组返回 {mean:0, stddev:0}，NaN 值自动过滤
 */
export function meanAndStddev(values) {
    const filtered = values.filter((v) => !Number.isNaN(v) && Number.isFinite(v));
    if (filtered.length === 0)
        return { mean: 0, stddev: 0 };
    const n = filtered.length;
    const mean = filtered.reduce((sum, v) => sum + v, 0) / n;
    if (n === 1)
        return { mean, stddev: 0 };
    const variance = filtered.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n;
    return { mean, stddev: Math.sqrt(variance) };
}
/**
 * z-score 异常检测
 * @param current - 当前值
 * @param baseline - 基线（mean, stddev）
 * @param threshold - z-score 阈值，默认 2
 * severity 规则：|zScore| > 3 → critical, > 2 → warning, else normal
 * stddev = 0 时返回 {zScore: 0, isAnomaly: false, severity: 'normal'}
 */
export function zScoreTest(current, baseline, threshold = 2) {
    if (baseline.stddev === 0) {
        return { zScore: 0, isAnomaly: false, severity: 'normal' };
    }
    const zScore = (current - baseline.mean) / baseline.stddev;
    const absZScore = Math.abs(zScore);
    const isAnomaly = absZScore > threshold;
    let severity;
    if (absZScore > 3) {
        severity = 'critical';
    }
    else if (absZScore > 2) {
        severity = 'warning';
    }
    else {
        severity = 'normal';
    }
    return { zScore, isAnomaly, severity };
}
// ============================================================
// 滑动窗口基线
// ============================================================
/**
 * 取最后 windowSize 个元素计算基线
 * @param values - 数值数组
 * @param windowSize - 窗口大小，默认 values.length
 */
export function rollingBaseline(values, windowSize) {
    const size = windowSize ?? values.length;
    const window = values.slice(-Math.min(size, values.length));
    return meanAndStddev(window);
}
/**
 * 连续趋势检测
 * @param values - 每日数值数组（按时间顺序）
 * @param minConsecutive - 最小连续天数，默认 3
 * 第一天不算（需要比较），从第二天开始看每日差值
 * 输入长度 < 2 → {direction:'stable', consecutiveDays:0}
 */
export function detectTrend(values, minConsecutive = 3) {
    if (values.length < 2) {
        return { direction: 'stable', consecutiveDays: 0 };
    }
    const filtered = values.filter((v) => !Number.isNaN(v));
    if (filtered.length < 2) {
        return { direction: 'stable', consecutiveDays: 0 };
    }
    // 计算每日差值
    const diffs = [];
    for (let i = 1; i < filtered.length; i++) {
        diffs.push(filtered[i] - filtered[i - 1]);
    }
    // 统计连续同向天数
    let streak = 1; // 从第二项开始算第一天
    let maxStreak = 1;
    let currentDirection = 'stable';
    for (let i = 0; i < diffs.length; i++) {
        const dir = diffs[i] > 0 ? 'up' : 'down';
        if (i === 0) {
            currentDirection = dir;
            continue;
        }
        const prevDir = diffs[i - 1] > 0 ? 'up' : 'down';
        if (dir === prevDir) {
            streak++;
            if (streak > maxStreak) {
                maxStreak = streak;
                currentDirection = dir;
            }
        }
        else {
            streak = 1;
        }
    }
    // 连续天数 = maxStreak + 1（补算第一天）
    const consecutiveDays = maxStreak + 1;
    if (consecutiveDays >= minConsecutive) {
        return { direction: currentDirection, consecutiveDays };
    }
    return { direction: 'stable', consecutiveDays: 0 };
}
/**
 * 单日突变检测
 * @param current - 当前值
 * @param previous - 前一天值
 * @param thresholdRatio - 阈值比例，默认 0.5（50% 变化）
 * deltaRatio = |current - previous| / max(|previous|, epsilon)
 * previous = 0 → 用 epsilon=0.001 防止除以零
 */
export function detectDelta(current, previous, thresholdRatio = 0.5) {
    const epsilon = 0.001;
    const denominator = Math.max(Math.abs(previous), epsilon);
    const deltaRatio = Math.abs(current - previous) / denominator;
    return {
        deltaRatio,
        isAnomaly: deltaRatio >= thresholdRatio,
    };
}
// ============================================================
// 百分位
// ============================================================
/**
 * 百分位计算（线性插值）
 * @param values - 数值数组
 * @param p - 百分位 (0-100)
 * 空数组返回 0
 * p < 0 或 p > 100 返回 NaN
 */
export function percentile(values, p) {
    if (values.length === 0)
        return 0;
    if (p < 0 || p > 100)
        return NaN;
    const sorted = [...values].filter((v) => !Number.isNaN(v)).sort((a, b) => a - b);
    if (sorted.length === 0)
        return 0;
    const index = (p / 100) * (sorted.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    if (lower === upper)
        return sorted[lower];
    const weight = index - lower;
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}
//# sourceMappingURL=anomaly-detector.js.map