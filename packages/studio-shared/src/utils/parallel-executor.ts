/**
 * 并行执行器
 *
 * 提供并发池、失败容错、进度追踪、超时控制能力。
 * 从 agent-platform/runtime 提取，已解耦 runtime 特定类型。
 */

import { getResourceAwareConcurrency } from './scheduler';

// ========== Types ==========

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
  failures: Array<{ stepId: string; error: Error }>;
  status: 'all_success' | 'partial_success' | 'all_failed';
}

export interface ExecutableTask {
  id: string;
  timeout?: number;
}

// ========== Constants ==========

const DEFAULT_MAX_CONCURRENT = 5;
const DEFAULT_TIMEOUT = 300000;

// ========== Helper Functions ==========

export function batchArray<T>(array: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < array.length; i += batchSize) {
    batches.push(array.slice(i, i + batchSize));
  }
  return batches;
}

// ========== Parallel Executor ==========

export class ParallelExecutor<T extends ExecutableTask = ExecutableTask, R = any> {
  private options: ParallelOptions;
  private results: Map<string, R>;
  private failures: Array<{ stepId: string; error: Error }>;
  private running: number;
  private completed: number;

  constructor(options?: ParallelOptions) {
    this.options = {
      maxConcurrent: options?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
      failStrategy: options?.failStrategy ?? 'continue',
      timeout: options?.timeout ?? DEFAULT_TIMEOUT,
      onProgress: options?.onProgress,
    };
    this.results = new Map();
    this.failures = [];
    this.running = 0;
    this.completed = 0;
  }

  async execute(
    tasks: T[],
    executorFn: (task: T) => Promise<R>
  ): Promise<ParallelResult<R>> {
    if (!tasks || tasks.length === 0) {
      return this.getEmptyResult();
    }

    const { concurrency, reason } = getResourceAwareConcurrency(this.options.maxConcurrent!);

    if (reason) {
      console.warn(`Resource awareness: ${reason}`);
    }

    const batches = batchArray(tasks, concurrency);

    for (const batch of batches) {
      await this.executeBatch(batch, executorFn);

      if (this.failures.length > 0 && this.options.failStrategy === 'all') {
        break;
      }
    }

    return this.getResult();
  }

  private async executeBatch(
    batch: T[],
    executorFn: (task: T) => Promise<R>
  ): Promise<void> {
    this.running = batch.length;

    const batchResults = await Promise.allSettled(
      batch.map(async (task) => {
        this.notifyProgress(task.id, 'start');

        try {
          const result = await this.executeWithTimeout(task, executorFn);
          return { task, result };
        } finally {
          this.running--;
        }
      })
    );

    for (let i = 0; i < batchResults.length; i++) {
      const settled = batchResults[i];
      if (settled.status === 'fulfilled') {
        const { task, result } = settled.value;
        this.results.set(task.id, result);
        this.completed++;
        this.notifyProgress(task.id, 'success');
      } else {
        const task = batch[i];
        const error = settled.reason instanceof Error
          ? settled.reason
          : new Error(String(settled.reason));
        this.failures.push({ stepId: task.id, error });
        this.completed++;
        this.notifyProgress(task.id, 'fail');

        if (this.options.failStrategy === 'all') {
          throw error;
        }
      }
    }
  }

  private async executeWithTimeout(
    task: T,
    executorFn: (task: T) => Promise<R>
  ): Promise<R> {
    const timeout = task.timeout ?? this.options.timeout ?? DEFAULT_TIMEOUT;

    return Promise.race([
      executorFn(task),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Task ${task.id} timeout after ${timeout}ms`)), timeout)
      ),
    ]);
  }

  private notifyProgress(stepId: string, status: ProgressStatus): void {
    if (!this.options.onProgress) return;

    const total = this.results.size + this.failures.length + this.running;

    this.options.onProgress({
      completed: this.completed,
      total,
      running: this.running,
      failed: this.failures.length,
      stepId,
      status,
    });
  }

  private getResult(): ParallelResult<R> {
    const successes = Array.from(this.results.keys());
    const allFailed = successes.length === 0;
    const allSuccess = this.failures.length === 0;

    return {
      results: this.results,
      successes,
      failures: this.failures,
      status: allSuccess ? 'all_success' :
              allFailed ? 'all_failed' : 'partial_success',
    };
  }

  private getEmptyResult(): ParallelResult<R> {
    return {
      results: new Map(),
      successes: [],
      failures: [],
      status: 'all_success',
    };
  }
}

export async function executeParallel<T extends ExecutableTask = ExecutableTask, R = any>(
  tasks: T[],
  executorFn: (task: T) => Promise<R>,
  options?: ParallelOptions
): Promise<ParallelResult<R>> {
  const executor = new ParallelExecutor<T, R>(options);
  return executor.execute(tasks, executorFn);
}
