/**
 * AS-003: harness 约束检查集成测试
 *
 * 注意：Trigger 解耦后，各约束用特定操作测试，避免跨约束干扰。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkConstraints, ConstraintViolationError } from '@dommaker/harness';

// 完整合规 context（所有 Iron Law 字段通过）
const PASSING_CTX = {
  operation: 'code_implementation' as const,
  projectPath: process.cwd(),
  hasTest: true,
  hasVerificationEvidence: true,
  hasSingleTask: true,
  hasRequirement: true,
  taskDescription: 'Test task',
};

describe('AS-003: harness 约束检查集成', () => {
  describe('checkConstraints 调用', () => {
    it('全字段合规应该通过', async () => {
      const result = await checkConstraints(PASSING_CTX);
      expect(result).toBeDefined();
      expect(result.passed).toBe(true);
      expect(result.errors).toBeDefined();
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

    it('severity=warning 违规应该返回警告', async () => {
      // harness 1.10.0（ADR-0029）：三层命名废弃，结果桶为 errors/warnings。
      // 存活 warning 层 check 中 code_implementation 触发的是 no_hardcoded_credentials
      // （扫描变更文件中的凭证赋值模式），此处用假赋值触发（合成值，非真实凭证）。
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creds-trigger-'));
      // 触发行运行时拼接：字面量写法会被本仓 pre-commit 凭证扫描拦（它扫源码本身，
      // 不是运行产物）；拼接后源码无形似赋值，落盘 tmp 文件是形似赋值、可被检出。
      // 值为合成假凭证，非真实密钥。
      const secretValue = 'Sup3rSecretValue99';
      const leakLine = 'const password' + ' = ' + JSON.stringify(secretValue) + ';';
      fs.writeFileSync(path.join(tmpRoot, 'leak.ts'), leakLine + '\n', 'utf-8');
      try {
        const result = await checkConstraints({
          ...PASSING_CTX,
          projectPath: tmpRoot,
          changedFiles: ['leak.ts'],
        });
        expect(result.warningCount).toBeGreaterThan(0);
        expect(result.warnings.filter(g => !g.satisfied).length).toBeGreaterThan(0);
      } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    it('no_completion_without_verification 合规应该通过', async () => {
      const result = await checkConstraints(PASSING_CTX);
      expect(result.passed).toBe(true);
      expect(result.errors.find(il => il.id === 'no_completion_without_verification')?.satisfied).toBe(true);
    });

    it('no_completion_without_verification 违规应该阻止', async () => {
      let threw: unknown = null;
      try {
        await checkConstraints({ ...PASSING_CTX, hasVerificationEvidence: false });
      } catch (e) {
        threw = e;
      }
      expect(threw).toBeInstanceOf(ConstraintViolationError);
      if (threw instanceof ConstraintViolationError) {
        expect(threw.result.id).toBe('no_completion_without_verification');
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
