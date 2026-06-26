/**
 * Pipeline Contract Test
 *
 * 验证 goal/goalExecution prisma 模型在管线中的正确使用：
 * - Goal 查询用 prisma.goal（非 workUnitService）
 * - Execution 查询用 prisma.goalExecution（非 workUnitService）
 * - 状态值：pending/running/succeeded/failed（非 unassigned/active/done/closed）
 * - 字段：goalId（非 parentId），独立列（非 metadata JSON）
 *
 * 同时验证 Knowledge feedback loop 接线：
 * - workUnitFeedback → scheduler-dispatch.ts
 * - extractFromExecution → scheduler-dispatch.ts
 * - recordOutcome → goal-lifecycle.ts recordGoalCompletion
 * - recordKnowledgeRefs → scheduler-dispatch.ts
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

  describe('Goal/GoalExecution prisma model usage', () => {
    it('scheduler-dispatch uses prisma.goalExecution for execution queries', () => {
      expect(dispatchSrc).toContain('prisma.goalExecution');
    });

    it('scheduler-dispatch uses prisma.goal for goal queries', () => {
      expect(dispatchSrc).toContain('prisma.goal');
    });

    it('goal-lifecycle uses prisma.goalExecution for execution updates', () => {
      expect(lifecycleSrc).toContain('prisma.goalExecution.update');
    });

    it('goal-lifecycle uses prisma.goalExecution.findUnique for execution lookups', () => {
      expect(lifecycleSrc).toContain('prisma.goalExecution.findUnique');
    });

    it('goal-lifecycle uses prisma.goal.findUnique for goal lookups', () => {
      expect(lifecycleSrc).toContain('prisma.goal.findUnique');
    });
  });

  describe('Status values use new mapping (not workUnit statuses)', () => {
    it('does NOT use unassigned status (should be pending)', () => {
      expect(dispatchSrc).not.toMatch(/transitionStatus\(.*'unassigned'\)/);
    });

    it('does NOT use active status (should be running)', () => {
      expect(dispatchSrc).not.toMatch(/transitionStatus\(.*'active'\)/);
    });

    it('does NOT use done status (should be succeeded)', () => {
      expect(dispatchSrc).not.toMatch(/transitionStatus\(.*'done'\)/);
    });

    it('does NOT use closed status (should be failed)', () => {
      expect(dispatchSrc).not.toMatch(/transitionStatus\(.*'closed'\)/);
    });

    it('uses pending status for new executions', () => {
      expect(dispatchSrc).toMatch(/'pending'/);
    });

    it('uses running status for active executions', () => {
      expect(dispatchSrc).toMatch(/'running'/);
    });

    it('uses succeeded status for completed executions', () => {
      expect(dispatchSrc).toMatch(/'succeeded'/);
    });

    it('uses failed status for failed executions', () => {
      expect(dispatchSrc).toMatch(/'failed'/);
    });

    it('goal-lifecycle uses correct status values', () => {
      expect(lifecycleSrc).toMatch(/'succeeded'/);
      expect(lifecycleSrc).toMatch(/'failed'/);
    });
  });

  describe('Field mapping (goalId not parentId, independent columns not metadata JSON)', () => {
    it('uses goalId field (not parentId)', () => {
      expect(dispatchSrc).toContain('goalId');
      expect(dispatchSrc).not.toContain('parentId');
    });

    it('goal-lifecycle uses goalId for execution-goal relation', () => {
      expect(lifecycleSrc).toContain('goalId');
    });

    it('does NOT use workUnitService for DB operations', () => {
      expect(dispatchSrc).not.toContain('workUnitService.update');
      expect(dispatchSrc).not.toContain('workUnitService.transitionStatus');
      expect(dispatchSrc).not.toContain('workUnitService.getById');
    });

    it('does NOT import WorkUnitService', () => {
      expect(dispatchSrc).not.toContain("from '../workunit/workunit.service'");
      expect(dispatchSrc).not.toContain('WorkUnitService');
    });

    it('does NOT import status-mapping from workunit', () => {
      expect(dispatchSrc).not.toContain("from '../workunit/status-mapping'");
    });
  });

  describe('scheduler-dispatch.ts wiring', () => {
    it('calls workUnitFeedback on success path', () => {
      expect(dispatchSrc).toContain('knowledgeService.workUnitFeedback');
      // success path: after "Agent succeeded" log
      const successBlock = dispatchSrc.slice(
        dispatchSrc.indexOf('Agent succeeded'),
        dispatchSrc.indexOf('Agent failed') || dispatchSrc.length,
      );
      expect(successBlock).toContain('workUnitFeedback');
      expect(successBlock).toContain('success: true');
    });

    it('calls workUnitFeedback on failure path', () => {
      // failure path: after "Agent failed" log
      const failIdx = dispatchSrc.indexOf('// ── Knowledge feedback loop: workUnitFeedback (failure)');
      expect(failIdx).toBeGreaterThan(-1);
      const failBlock = dispatchSrc.slice(failIdx, failIdx + 500);
      expect(failBlock).toContain('workUnitFeedback');
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
      const failFeedbackIdx = dispatchSrc.indexOf('Knowledge feedback loop: workUnitFeedback (failure)');
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

    it('passes goalId to workUnitFeedback', () => {
      // Both success and failure paths must pass goalId
      const matches = dispatchSrc.match(/workUnitFeedback\(\{[\s\S]*?\}\)/g);
      expect(matches).not.toBeNull();
      for (const m of matches!) {
        expect(m).toContain('goalId');
      }
    });

    it('passes phase to workUnitFeedback', () => {
      const matches = dispatchSrc.match(/workUnitFeedback\(\{[\s\S]*?\}\)/g);
      expect(matches).not.toBeNull();
      for (const m of matches!) {
        expect(m).toContain("phase: 'executor'");
      }
    });

    it('non-blocking: knowledge feedback calls are wrapped in try/catch', () => {
      // Each call site should have try/catch with /* non-blocking */
      const nonBlockingCount = (dispatchSrc.match(/\/\* non-blocking \*\//g) || []).length;
      // At least 2 for workUnitFeedback + 1 for extractFromExecution
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

    it('recordExecution passes goalId', () => {
      // Use lastIndexOf to find the call site, not the import statement
      const callIdx = lifecycleSrc.lastIndexOf('recordExecution({');
      expect(callIdx).toBeGreaterThan(-1);
      const recordCall = lifecycleSrc.slice(callIdx, callIdx + 500);
      expect(recordCall).toContain('goalId');
    });
  });
});
