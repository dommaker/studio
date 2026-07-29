/**
 * 计算数组的均值和标准差（总体标准差）
 * @param values - 数值数组，空数组返回 {mean:0, stddev:0}，NaN 值自动过滤
 */
export declare function meanAndStddev(values: number[]): {
    mean: number;
    stddev: number;
};
export interface ZScoreResult {
    zScore: number;
    isAnomaly: boolean;
    severity: 'normal' | 'warning' | 'critical';
}
/**
 * z-score 异常检测
 * @param current - 当前值
 * @param baseline - 基线（mean, stddev）
 * @param threshold - z-score 阈值，默认 2
 * severity 规则：|zScore| > 3 → critical, > 2 → warning, else normal
 * stddev = 0 时返回 {zScore: 0, isAnomaly: false, severity: 'normal'}
 */
export declare function zScoreTest(current: number, baseline: {
    mean: number;
    stddev: number;
}, threshold?: number): ZScoreResult;
/**
 * 取最后 windowSize 个元素计算基线
 * @param values - 数值数组
 * @param windowSize - 窗口大小，默认 values.length
 */
export declare function rollingBaseline(values: number[], windowSize?: number): {
    mean: number;
    stddev: number;
};
export interface TrendResult {
    direction: 'up' | 'down' | 'stable';
    consecutiveDays: number;
}
/**
 * 连续趋势检测
 * @param values - 每日数值数组（按时间顺序）
 * @param minConsecutive - 最小连续天数，默认 3
 * 第一天不算（需要比较），从第二天开始看每日差值
 * 输入长度 < 2 → {direction:'stable', consecutiveDays:0}
 */
export declare function detectTrend(values: number[], minConsecutive?: number): TrendResult;
export interface DeltaResult {
    deltaRatio: number;
    isAnomaly: boolean;
}
/**
 * 单日突变检测
 * @param current - 当前值
 * @param previous - 前一天值
 * @param thresholdRatio - 阈值比例，默认 0.5（50% 变化）
 * deltaRatio = |current - previous| / max(|previous|, epsilon)
 * previous = 0 → 用 epsilon=0.001 防止除以零
 */
export declare function detectDelta(current: number, previous: number, thresholdRatio?: number): DeltaResult;
/**
 * 百分位计算（线性插值）
 * @param values - 数值数组
 * @param p - 百分位 (0-100)
 * 空数组返回 0
 * p < 0 或 p > 100 返回 NaN
 */
export declare function percentile(values: number[], p: number): number;
//# sourceMappingURL=anomaly-detector.d.ts.map