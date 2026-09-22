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

    it('severity=warning 违规应该返回警告（不阻断）', async () => {
      // harness 1.12.0（ADR-0032）：no_hardcoded_credentials 升 error 级后，
      // code_implementation 域内已无 warning 级约束（harness 同款先例 ac09266：
      // 触发域改 module_modification）。存活 warning 载体改走 governance_presence：
      // tmp 项目放 .harness/config.yml（视为采用 harness 治理）但不放治理正本
      // （AGENTS.md PRESERVE:governance 段 / CLAUDE.md Governance Rules 块），
      // 该 warning 约束判违规且 checkConstraints 不抛。
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'governance-presence-trigger-'));
      try {
        fs.mkdirSync(path.join(tmpRoot, '.harness'));
        fs.writeFileSync(path.join(tmpRoot, '.harness', 'config.yml'), 'preset: standard\n', 'utf-8');
        const result = await checkConstraints({
          ...PASSING_CTX,
          operation: 'module_modification' as const,
          projectPath: tmpRoot,
        });
        expect(result.warningCount).toBeGreaterThan(0);
        expect(
          result.warnings.some(g => g.id === 'governance_presence' && !g.satisfied),
        ).toBe(true);
      } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    it('no_hardcoded_credentials 违规应该阻断（harness 1.12.0 起为 error 级）', async () => {
      // ADR-0032：安全底线 warning 不阻断等于没有——升 error 级，违规即抛。
      // 钉 studio 依赖面采纳该行为：凭证赋值模式命中 → ConstraintViolationError。
      // 值为合成假凭证，非真实密钥。源码以 ${...} 占位形态直写：本仓 pre-commit
      // 凭证扫描对该形态豁免（判据与 harness checker 一致，见 studio#608）；
      // 落盘 tmp 文件是形似赋值、可被 checker 检出。
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creds-trigger-'));
      const fakeSecret = 'Sup3rSecretValue99';
      const leakLine = `const password = "${fakeSecret}";`;
      fs.writeFileSync(path.join(tmpRoot, 'leak.ts'), leakLine + '\n', 'utf-8');
      let threw: unknown = null;
      try {
        await checkConstraints({
          ...PASSING_CTX,
          projectPath: tmpRoot,
          changedFiles: ['leak.ts'],
        });
      } catch (e) {
        threw = e;
      } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
      expect(threw).toBeInstanceOf(ConstraintViolationError);
      if (threw instanceof ConstraintViolationError) {
        expect(threw.result.id).toBe('no_hardcoded_credentials');
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
