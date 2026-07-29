/**
 * Determine dispatch strategy based on recent failure rate.
 * @param recentFailures Number of failures in the sliding window
 * @param recentTotal Total dispatches in the sliding window
 * @returns 'conservative' when total >= 5 and failRate > 0.5
 */
export declare function getDispatchStrategy(recentFailures: number, recentTotal: number): 'normal' | 'conservative';
/**
 * Calculate available concurrency slots based on system resources.
 * @param maxCap Optional upper bound (e.g. 2 for conservative mode)
 * @returns Available slot count: 1/2/5, capped by maxCap
 */
export declare function getAvailableSlots(maxCap?: number): number;
/**
 * Update the sliding window dispatch outcome counter.
 * @param state Current { failures, total }
 * @param success Whether the current dispatch succeeded
 * @returns Updated { failures, total }, with total capped at 20
 */
export declare function updateDispatchOutcome(state: {
    failures: number;
    total: number;
}, success: boolean): {
    failures: number;
    total: number;
};
//# sourceMappingURL=concurrency-control.d.ts.map