/**
 * AS-003: harness 约束检查集成测试
 *
 * 注意：Trigger 解耦后，各约束用特定操作测试，避免跨约束干扰。
 */
import { describe, it, expect } from 'vitest';
import { checkConstraints, ConstraintViolationError } from '@dommaker/harness';

// 完整合规 context（所有 Iron Law 字段通过）
const PASSING_CTX = {
  operation: 'code_implementation' as const,
  projectPath: process.cwd(),
  hasTest: true,
  hasVerificationEvidence: true,
  hasSingleTask: true,
  hasRequirement: true,
  hasRequirementReview: true,
  hasTwoStageReview: true,
  hasWorktree: true,
  completionClaimText: '142 tests passed, coverage 87%',
  taskDescription: 'Test task',
};

describe('AS-003: harness 约束检查集成', () => {
  describe('checkConstraints 调用', () => {
    it('全字段合规应该通过', async () => {
      const result = await checkConstraints(PASSING_CTX);
      expect(result).toBeDefined();
      expect(result.passed).toBe(true);
      expect(result.ironLaws).toBeDefined();
    });

    it('no_self_approval 违规应该抛出（需要 task_completion_claim trigger）', async () => {
      try {
        await checkConstraints({ operation: 'task_completion_claim', hasTest: false });
      } catch (e) {
        expect(e instanceof ConstraintViolationError).toBe(true);
        if (e instanceof ConstraintViolationError) {
          expect(e.result.id).toBe('no_self_approval');
          expect(e.result.satisfied).toBe(false);
        }
      }
    });

    it('Guidelines 违规应该返回警告', async () => {
      const result = await checkConstraints({
        ...PASSING_CTX,
        hasRootCauseInvestigation: false,
      });
      expect(result.warningCount).toBeGreaterThan(0);
      expect(result.guidelines.filter(g => !g.satisfied).length).toBeGreaterThan(0);
    });

    it('incremental_progress 合规应该通过', async () => {
      const result = await checkConstraints(PASSING_CTX);
      expect(result.passed).toBe(true);
      expect(result.ironLaws.find(il => il.id === 'incremental_progress')?.satisfied).toBe(true);
    });

    it('incremental_progress 违规应该阻止', async () => {
      try {
        await checkConstraints({ ...PASSING_CTX, hasSingleTask: false });
      } catch (e) {
        expect(e instanceof ConstraintViolationError).toBe(true);
        if (e instanceof ConstraintViolationError) {
          expect(e.result.id).toBe('incremental_progress');
        }
      }
    });
  });

  describe('ConstraintContext 字段验证', () => {
    it('hasVerificationEvidence=false 触发 no_completion_without_verification', async () => {
      try {
        await checkConstraints({ ...PASSING_CTX, hasVerificationEvidence: false });
      } catch (e) {
        if (e instanceof ConstraintViolationError) {
          expect(e.result.id).toBe('no_completion_without_verification');
        }
      }
    });

    it('hasTest=false + task_completion_claim 触发 no_self_approval', async () => {
      try {
        await checkConstraints({ operation: 'task_completion_claim', hasTest: false });
      } catch (e) {
        if (e instanceof ConstraintViolationError) {
          expect(e.result.id).toBe('no_self_approval');
        }
      }
    });
  });

  describe('Studio 集成场景', () => {
    it('正常 dispatch 前检查通过', async () => {
      const result = await checkConstraints({
        ...PASSING_CTX,
        projectPath: '/root/projects/agent-studio',
        sessionId: 'test-execution-id',
      });
      expect(result.passed).toBe(true);
    });

    it('完成声明缺测试证据阻塞', async () => {
      try {
        await checkConstraints({ operation: 'task_completion_claim', hasTest: false });
      } catch (e) {
        if (e instanceof ConstraintViolationError) {
          expect(e.result.id).toBe('no_self_approval');
        }
      }
    });
  });
});
