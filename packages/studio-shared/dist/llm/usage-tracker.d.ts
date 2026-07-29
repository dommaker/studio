/**
 * Usage Tracker — token/cost 用量统计
 *
 * P11-06: Extracted from model-gateway.ts
 */
import type { UsageRecord, GatewayStats } from './model-router.js';
/**
 * 记录用量
 */
export declare function recordUsage(log: UsageRecord[], record: UsageRecord): UsageRecord[];
/**
 * 获取用量统计
 */
export declare function getStats(usageLog: UsageRecord[]): GatewayStats;
/**
 * 获取最近 N 条调用记录
 */
export declare function getRecentUsage(usageLog: UsageRecord[], n?: number): UsageRecord[];
/**
 * 质量评分
 */
export declare function scoreQuality(content: string, finishReason: string | undefined, latencyMs: number): number;
//# sourceMappingURL=usage-tracker.d.ts.map