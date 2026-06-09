/**
 * Pipeline Contract Test
 *
 * 验证 Knowledge feedback loop 三个方法已正确接线到管线：
 * - pipelineStepFeedback → scheduler-dispatch.ts (成功+失败路径)
 * - extractFromExecution → scheduler-dispatch.ts (成功+失败路径)
 * - recordOutcome → goal-lifecycle.ts recordGoalCompletion
 * - recordKnowledgeRefs → scheduler-dispatch.ts (成功+失败路径)
 *
 * 这是源码级契约测试，不运行管线，只验证接线存在。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SRC_ROOT = path.resolve(__dirname, '..');

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(SRC_ROOT, relativePath), 'utf-8');
}

describe('Pipeline feedback loop contract', () => {
  const dispatchSrc = readSource('scheduler-dispatch.ts');
  const lifecycleSrc = readSource('goal-lifecycle.ts');

  describe('scheduler-dispatch.ts wiring', () => {
    it('calls pipelineStepFeedback on success path', () => {
      expect(dispatchSrc).toContain('knowledgeService.pipelineStepFeedback');
      // success path: after "Agent succeeded" log
      const successBlock = dispatchSrc.slice(
        dispatchSrc.indexOf('Agent succeeded'),
        dispatchSrc.indexOf('Agent failed') || dispatchSrc.length,
      );
      expect(successBlock).toContain('pipelineStepFeedback');
      expect(successBlock).toContain('success: true');
    });

    it('calls pipelineStepFeedback on failure path', () => {
      // failure path: after "Agent failed" log
      const failIdx = dispatchSrc.indexOf('// ── Knowledge feedback loop: pipelineStepFeedback (failure)');
      expect(failIdx).toBeGreaterThan(-1);
      const failBlock = dispatchSrc.slice(failIdx, failIdx + 500);
      expect(failBlock).toContain('pipelineStepFeedback');
      expect(failBlock).toContain('success: false');
    });

    it('calls extractFromExecution on success path', () => {
      expect(dispatchSrc).toContain('knowledgeService.extractFromExecution');
      // Verify extractFromExecution appears after "Agent succeeded" log
      const successIdx = dispatchSrc.indexOf('Agent succeeded');
      const extractIdx = dispatchSrc.indexOf('extractFromExecution');
      expect(extractIdx).toBeGreaterThan(successIdx);
    });

    it('calls extractFromExecution on failure path', () => {
      // Verify extractFromExecution also called on failure path (success: false)
      const failFeedbackIdx = dispatchSrc.indexOf('Knowledge feedback loop: pipelineStepFeedback (failure)');
      expect(failFeedbackIdx).toBeGreaterThan(-1);
      const failBlock = dispatchSrc.slice(failFeedbackIdx, dispatchSrc.indexOf('handleDispatchFailure', failFeedbackIdx + 1) || dispatchSrc.length);
      expect(failBlock).toContain('extractFromExecution');
      expect(failBlock).toContain('success: false');
    });

    it('calls recordKnowledgeRefs on success path', () => {
      expect(dispatchSrc).toContain('recordKnowledgeRefs');
      const successBlock = dispatchSrc.slice(
        dispatchSrc.indexOf('Agent succeeded'),
        dispatchSrc.indexOf('Agent failed') || dispatchSrc.length,
      );
      expect(successBlock).toContain('recordKnowledgeRefs');
    });

    it('calls recordKnowledgeRefs on failure path', () => {
      const failIdx = dispatchSrc.indexOf('Agent failed');
      expect(failIdx).toBeGreaterThan(-1);
      // Window expanded: failure classification/routing code added between Agent failed and knowledge loop
      const failBlock = dispatchSrc.slice(failIdx, failIdx + 5000);
      expect(failBlock).toContain('recordKnowledgeRefs');
    });

    it('passes goalId to pipelineStepFeedback', () => {
      // Both success and failure paths must pass goalId
      const matches = dispatchSrc.match(/pipelineStepFeedback\(\{[\s\S]*?\}\)/g);
      expect(matches).not.toBeNull();
      for (const m of matches!) {
        expect(m).toContain('goalId');
      }
    });

    it('passes phase to pipelineStepFeedback', () => {
      const matches = dispatchSrc.match(/pipelineStepFeedback\(\{[\s\S]*?\}\)/g);
      expect(matches).not.toBeNull();
      for (const m of matches!) {
        expect(m).toContain("phase: 'executor'");
      }
    });

    it('non-blocking: pipelineStepFeedback calls are wrapped in try/catch', () => {
      // Each call site should have try/catch with /* non-blocking */
      const nonBlockingCount = (dispatchSrc.match(/\/\* non-blocking \*\//g) || []).length;
      // At least 2 for pipelineStepFeedback + 1 for extractFromExecution
      expect(nonBlockingCount).toBeGreaterThanOrEqual(3);
    });
  });

  describe('goal-lifecycle.ts wiring', () => {
    it('calls recordOutcome in recordGoalCompletion', () => {
      expect(lifecycleSrc).toContain('knowledgeService.recordOutcome');
      // Verify recordOutcome appears after recordGoalCompletion function starts
      const funcIdx = lifecycleSrc.indexOf('async function recordGoalCompletion');
      const recordIdx = lifecycleSrc.indexOf('knowledgeService.recordOutcome');
      expect(recordIdx).toBeGreaterThan(funcIdx);
    });

    it('passes required fields to recordOutcome', () => {
      const recordCall = lifecycleSrc.slice(
        lifecycleSrc.indexOf('knowledgeService.recordOutcome'),
        lifecycleSrc.indexOf('knowledgeService.recordOutcome') + 500,
      );
      expect(recordCall).toContain('executionId');
      expect(recordCall).toContain('agentType');
      expect(recordCall).toContain('consumedKnowledge');
      expect(recordCall).toContain('success');
      expect(recordCall).toContain('details');
      expect(recordCall).toContain('timestamp');
      expect(recordCall).toContain("mode: 'pipeline'");
    });

    it('recordOutcome is non-blocking (try/catch)', () => {
      const recordIdx = lifecycleSrc.indexOf('knowledgeService.recordOutcome');
      // Look backwards for try
      const beforeRecord = lifecycleSrc.slice(Math.max(0, recordIdx - 200), recordIdx);
      expect(beforeRecord).toContain('try');
      // Look forward for catch
      const afterRecord = lifecycleSrc.slice(recordIdx, recordIdx + 500);
      expect(afterRecord).toContain('catch');
    });

    it('recordPipelineRun passes goalId', () => {
      // Use lastIndexOf to find the call site, not the import statement
      const callIdx = lifecycleSrc.lastIndexOf('recordPipelineRun({');
      expect(callIdx).toBeGreaterThan(-1);
      const recordCall = lifecycleSrc.slice(callIdx, callIdx + 500);
      expect(recordCall).toContain('goalId');
    });
  });
});
