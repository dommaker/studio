/**
 * 资源感知调度器
 *
 * 根据系统资源状态动态调整并发数。
 * 从 agent-platform/runtime 提取。
 */
import * as os from 'os';
export const DEFAULT_THRESHOLDS = {
    memoryHigh: 85,
    memoryCritical: 95,
    cpuHigh: 90,
    memoryReduceRatio: 0.5,
    cpuReduceRatio: 0.7,
};
export function getSystemMetrics() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const memoryUsage = ((totalMem - freeMem) / totalMem) * 100;
    const cpuCount = os.cpus().length;
    const loadAvg = os.loadavg()[0];
    const cpuLoad = (loadAvg / cpuCount) * 100;
    return { memoryUsage, cpuLoad, timestamp: Date.now() };
}
export function evaluateResourceStatus(metrics, thresholds = DEFAULT_THRESHOLDS) {
    if (metrics.memoryUsage >= thresholds.memoryCritical) {
        return { status: 'critical', reason: `Memory critical: ${metrics.memoryUsage.toFixed(1)}%` };
    }
    if (metrics.memoryUsage >= thresholds.memoryHigh) {
        return { status: 'high', reason: `Memory high: ${metrics.memoryUsage.toFixed(1)}%` };
    }
    if (metrics.cpuLoad >= thresholds.cpuHigh) {
        return { status: 'high', reason: `CPU high: ${metrics.cpuLoad.toFixed(1)}%` };
    }
    return { status: 'normal', reason: `Normal: mem ${metrics.memoryUsage.toFixed(1)}%, cpu ${metrics.cpuLoad.toFixed(1)}%` };
}
export function getResourceAwareConcurrency(base, thresholds = DEFAULT_THRESHOLDS) {
    const metrics = getSystemMetrics();
    const { status, reason } = evaluateResourceStatus(metrics, thresholds);
    let adjustedConcurrency = base;
    switch (status) {
        case 'critical':
            adjustedConcurrency = 1;
            break;
        case 'high':
            if (metrics.memoryUsage >= thresholds.memoryHigh) {
                adjustedConcurrency = Math.max(1, Math.floor(base * thresholds.memoryReduceRatio));
            }
            else if (metrics.cpuLoad >= thresholds.cpuHigh) {
                adjustedConcurrency = Math.max(1, Math.floor(base * thresholds.cpuReduceRatio));
            }
            break;
        case 'normal':
            adjustedConcurrency = base;
            break;
    }
    return { concurrency: adjustedConcurrency, metrics, status, reason };
}
export class ResourceScheduler {
    thresholds;
    lastMetrics = null;
    cacheTTL = 5000;
    lastCheckTime = 0;
    constructor(thresholds) {
        this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
    }
    getConcurrency(base) {
        const now = Date.now();
        if (this.lastMetrics && now - this.lastCheckTime < this.cacheTTL) {
            const { status, reason } = evaluateResourceStatus(this.lastMetrics, this.thresholds);
            let adjustedConcurrency = base;
            switch (status) {
                case 'critical':
                    adjustedConcurrency = 1;
                    break;
                case 'high':
                    if (this.lastMetrics.memoryUsage >= this.thresholds.memoryHigh) {
                        adjustedConcurrency = Math.max(1, Math.floor(base * this.thresholds.memoryReduceRatio));
                    }
                    else {
                        adjustedConcurrency = Math.max(1, Math.floor(base * this.thresholds.cpuReduceRatio));
                    }
                    break;
                case 'normal':
                    adjustedConcurrency = base;
                    break;
            }
            return { concurrency: adjustedConcurrency, metrics: this.lastMetrics, status, reason };
        }
        const result = getResourceAwareConcurrency(base, this.thresholds);
        this.lastMetrics = result.metrics;
        this.lastCheckTime = now;
        return result;
    }
    forceRefresh() {
        this.lastMetrics = getSystemMetrics();
        this.lastCheckTime = Date.now();
        return this.lastMetrics;
    }
    updateThresholds(thresholds) {
        this.thresholds = { ...this.thresholds, ...thresholds };
    }
    getThresholds() {
        return { ...this.thresholds };
    }
}
export function createResourceScheduler(thresholds) {
    return new ResourceScheduler(thresholds);
}
//# sourceMappingURL=scheduler.js.map