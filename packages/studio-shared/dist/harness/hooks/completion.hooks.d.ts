/**
 * Completion & Review Phase Hooks
 *
 * Task/GoalExecution 完成 → PassesGate → Review → FailureRecorder
 */
import type { TestResult } from '@dommaker/harness';
/** 任务完成前：测试门控 */
export declare function checkBeforeTaskComplete(testResults: TestResult[], config?: {
    requireEvidence?: boolean;
}): Promise<{
    allowed: boolean;
    violations: string[];
}>;
/** 审查完成后：记录 trace + 失败记录 */
export declare function afterReview(params?: {
    executionId?: string;
    approved?: boolean;
    score?: number;
    issueCount?: number;
    cycle?: number;
}): Promise<void>;
//# sourceMappingURL=completion.hooks.d.ts.map