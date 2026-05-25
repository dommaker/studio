/**
 * Completion & Review Phase Hooks
 *
 * Task/GoalExecution 完成 → PassesGate → Review → FailureRecorder
 */

import { PassesGate, getTraceCollector, createFailureRecorder, ErrorType, FailureLevel } from '@dommaker/harness';
import type { TestResult } from '@dommaker/harness';

/** 任务完成前：测试门控 */
export async function checkBeforeTaskComplete(
  testResults: TestResult[],
  config?: { requireEvidence?: boolean },
): Promise<{ allowed: boolean; violations: string[] }> {
  const gate = new PassesGate(config);
  // Pass the first test result directly — gate.check() expects {passed, evidence}, not {testResults: [...]}
  const result = await gate.check(testResults[0] || { passed: false, command: 'unknown' } as any);
  return {
    allowed: result.allowed,
    violations: result.violations?.map((v: any) => v.message) || [],
  };
}

/** 审查完成后：记录 trace + 失败记录 */
export async function afterReview(params?: {
  executionId?: string;
  approved?: boolean;
  score?: number;
  issueCount?: number;
  cycle?: number;
}): Promise<void> {
  const collector = getTraceCollector();
  const traceBase = {
    agentType: 'claude',
    phase: 'review',
    operation: 'code_review',
    message: params?.approved
      ? `Review passed (score: ${params?.score}, cycle: ${params?.cycle})`
      : `Review not approved (score: ${params?.score}, issues: ${params?.issueCount})`,
    details: params,
  };

  if (params?.approved) {
    collector.recordPass('review_gate', 'guideline', traceBase);
  } else {
    collector.recordFail('review_gate', 'guideline', traceBase);

    // 审查失败 → 写入 FailureRecorder
    const recorder = createFailureRecorder({ logFile: '.harness/logs/failures.log' });
    recorder.record({
      type: ErrorType.GATE_FAILED,
      level: FailureLevel.L2,
      message: traceBase.message,
      timestamp: Date.now(),
      metadata: { review: params },
    });
  }
}
