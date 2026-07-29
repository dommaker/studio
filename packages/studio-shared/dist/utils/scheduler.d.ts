/**
 * 资源感知调度器
 *
 * 根据系统资源状态动态调整并发数。
 * 从 agent-platform/runtime 提取。
 */
export interface ResourceMetrics {
    memoryUsage: number;
    cpuLoad: number;
    timestamp: number;
}
export interface ResourceThresholds {
    memoryHigh: number;
    memoryCritical: number;
    cpuHigh: number;
    memoryReduceRatio: number;
    cpuReduceRatio: number;
}
export declare const DEFAULT_THRESHOLDS: ResourceThresholds;
export declare function getSystemMetrics(): ResourceMetrics;
export type ResourceStatus = 'normal' | 'high' | 'critical';
export declare function evaluateResourceStatus(metrics: ResourceMetrics, thresholds?: ResourceThresholds): {
    status: ResourceStatus;
    reason: string;
};
export declare function getResourceAwareConcurrency(base: number, thresholds?: ResourceThresholds): {
    concurrency: number;
    metrics: ResourceMetrics;
    status: ResourceStatus;
    reason: string;
};
export declare class ResourceScheduler {
    private thresholds;
    private lastMetrics;
    private cacheTTL;
    private lastCheckTime;
    constructor(thresholds?: Partial<ResourceThresholds>);
    getConcurrency(base: number): {
        concurrency: number;
        metrics: ResourceMetrics;
        status: ResourceStatus;
        reason: string;
    };
    forceRefresh(): ResourceMetrics;
    updateThresholds(thresholds: Partial<ResourceThresholds>): void;
    getThresholds(): ResourceThresholds;
}
export declare function createResourceScheduler(thresholds?: Partial<ResourceThresholds>): ResourceScheduler;
//# sourceMappingURL=scheduler.d.ts.map