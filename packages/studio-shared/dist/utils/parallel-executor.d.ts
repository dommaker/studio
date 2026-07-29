/**
 * 并行执行器
 *
 * 提供并发池、失败容错、进度追踪、超时控制能力。
 * 从 agent-platform/runtime 提取，已解耦 runtime 特定类型。
 */
export type FailStrategy = 'all' | 'continue' | 'best-effort';
export type ProgressStatus = 'start' | 'success' | 'fail';
export interface ProgressInfo {
    completed: number;
    total: number;
    running: number;
    failed: number;
    stepId: string;
    status: ProgressStatus;
}
export type ProgressCallback = (info: ProgressInfo) => void;
export interface ParallelOptions {
    maxConcurrent?: number;
    failStrategy?: FailStrategy;
    timeout?: number;
    onProgress?: ProgressCallback;
}
export interface ParallelResult<T = any> {
    results: Map<string, T>;
    successes: string[];
    failures: Array<{
        stepId: string;
        error: Error;
    }>;
    status: 'all_success' | 'partial_success' | 'all_failed';
}
export interface ExecutableTask {
    id: string;
    timeout?: number;
}
export declare function batchArray<T>(array: T[], batchSize: number): T[][];
export declare class ParallelExecutor<T extends ExecutableTask = ExecutableTask, R = any> {
    private options;
    private results;
    private failures;
    private running;
    private completed;
    constructor(options?: ParallelOptions);
    execute(tasks: T[], executorFn: (task: T) => Promise<R>): Promise<ParallelResult<R>>;
    private executeBatch;
    private executeWithTimeout;
    private notifyProgress;
    private getResult;
    private getEmptyResult;
}
export declare function executeParallel<T extends ExecutableTask = ExecutableTask, R = any>(tasks: T[], executorFn: (task: T) => Promise<R>, options?: ParallelOptions): Promise<ParallelResult<R>>;
//# sourceMappingURL=parallel-executor.d.ts.map