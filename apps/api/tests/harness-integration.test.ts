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

// 完整合规 context（全部 error 级约束字段通过）
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

    it('severity=warning 违规应该返回警告', async () => {
      // harness 1.10.0（ADR-0029）：三层命名废弃，结果桶为 errors/warnings。
      // 存活 warning 层 check 中 code_implementation 触发的是 no_hardcoded_credentials
      // （扫描变更文件中的凭证赋值模式），此处用假赋值触发（合成值，非真实凭证）。
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creds-trigger-'));
      // 值为合成假凭证，非真实密钥。源码以 ${...} 占位形态直写：本仓 pre-commit
      // 凭证扫描对该形态豁免（判据与 harness checker 一致，见 studio#608）；
      // 落盘 tmp 文件是形似赋值、可被 checker 检出。
      const fakeSecret = 'Sup3rSecretValue99';
      const leakLine = `const password = "${fakeSecret}";`;
      fs.writeFileSync(path.join(tmpRoot, 'leak.ts'), leakLine + '\n', 'utf-8');
      try {
        const result = await checkConstraints({
          ...PASSING_CTX,
          projectPath: tmpRoot,
          changedFiles: ['leak.ts'],
        });
        expect(result.warningCount).toBeGreaterThan(0);
        expect(
          result.warnings.some(g => g.id === 'no_hardcoded_credentials' && !g.satisfied),
        ).toBe(true);
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

  describe('Studio 集成场景', () => {
    it('正常 dispatch 前检查通过', async () => {
      const result = await checkConstraints({
        ...PASSING_CTX,
        projectPath: '/root/projects/agent-studio',
        sessionId: 'test-execution-id',
      });
      expect(result.passed).toBe(true);
    });
  });
});
