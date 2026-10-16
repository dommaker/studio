/**
 * 百分位计算（线性插值，type 7）
 *
 * 唯一正本：原 stats/anomaly-detector.ts 随零消费方整体退役（2026-10 死代码批次），
 * percentile 因 apps/api ops 指标聚合与 bench 主链路对齐两处消费而提取保留。
 */

/**
 * 百分位计算（线性插值）
 * @param values - 数值数组
 * @param p - 百分位 (0-100)
 * 空数组返回 0
 * p < 0 或 p > 100 返回 NaN
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  if (p < 0 || p > 100) return NaN;

  const sorted = [...values].filter((v) => !Number.isNaN(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;

  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  if (lower === upper) return sorted[lower];

  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}
