/**
 * AS-003: harness 约束检查集成测试
 *
 * 注意：Trigger 解耦后，各约束用特定操作测试，避免跨约束干扰。
 *
 * harness 1.15.0（harness#183 证据源重构）适配：no_completion_without_verification
 * 不再读 ConstraintContext.hasVerificationEvidence 自报标志（字段已退役），
 * 证据源 = <projectPath>/.harness/evidence/ 目录，新鲜度 = 最新证据 mtime ≥
 * 变更文件 mtime。合规/违规场景一律以 tmp 工程 + 证据落盘构造，与本仓工作区解耦。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkConstraints, ConstraintViolationError } from '@dommaker/harness';

// 完整合规 context 基座（全部 error 级约束字段通过；projectPath 由各场景注入）
const PASSING_CTX = {
  operation: 'code_implementation' as const,
  hasTest: true,
  hasSingleTask: true,
  hasRequirement: true,
  taskDescription: 'Test task',
};

/**
 * 建 tmp 工程根。withEvidence=true 时落一条验证证据
 * （.harness/evidence/ 下的文件即可——checker 只核存在性与时间，不读内容）。
 */
function mkProject(withEvidence: boolean): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-ctx-trigger-'));
  if (withEvidence) {
    fs.mkdirSync(path.join(root, '.harness', 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(root, '.harness', 'evidence', 'vitest.log'), 'pass\n', 'utf-8');
  }
  return root;
}

async function expectViolation(fn: () => Promise<unknown>): Promise<ConstraintViolationError> {
  let threw: unknown = null;
  try {
    await fn();
  } catch (e) {
    threw = e;
  }
  expect(threw).toBeInstanceOf(ConstraintViolationError);
  return threw as ConstraintViolationError;
}

describe('AS-003: harness 约束检查集成', () => {
  describe('checkConstraints 调用', () => {
    it('全字段合规应该通过', async () => {
      const root = mkProject(true);
      try {
        const result = await checkConstraints({ ...PASSING_CTX, projectPath: root, changedFiles: [] });
        expect(result).toBeDefined();
        expect(result.passed).toBe(true);
        expect(result.errors).toBeDefined();
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
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
      // 1.15.0 起本 tmp 工程须先有新鲜证据，否则 no_completion 抢先抛、
      // 干扰 result.id 断言——checker 独立于被检约束本身。
      // 新鲜度是 mtime 严格大于判定：证据 mtime 必须显式推后，靠它与写入同落
      // 一毫秒不可复现（合跑负载下跨 1ms 即翻红，2026-09-28 实测）。
      const tmpRoot = mkProject(true);
      const fakeSecret = 'Sup3rSecretValue99';
      const leakLine = `const password = "${fakeSecret}";`;
      fs.writeFileSync(path.join(tmpRoot, 'leak.ts'), leakLine + '\n', 'utf-8');
      const evidenceFile = path.join(tmpRoot, '.harness', 'evidence', 'vitest.log');
      const freshAt = Date.now() / 1000 + 1;
      fs.utimesSync(evidenceFile, freshAt, freshAt);
      try {
        const threw = await expectViolation(() =>
          checkConstraints({
            ...PASSING_CTX,
            projectPath: tmpRoot,
            changedFiles: ['leak.ts'],
          })
        );
        expect(threw.result.id).toBe('no_hardcoded_credentials');
      } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    it('no_completion_without_verification 合规应该通过', async () => {
      // 1.15.0 新口径：证据存在且晚于全部可读变更（changedFiles=[] = 真无变更）→ pass
      const root = mkProject(true);
      try {
        const result = await checkConstraints({ ...PASSING_CTX, projectPath: root, changedFiles: [] });
        expect(result.passed).toBe(true);
        expect(result.errors.find(il => il.id === 'no_completion_without_verification')?.satisfied).toBe(true);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('no_completion_without_verification 违规应该阻止', async () => {
      // 1.15.0 新口径触发方式：证据目录缺失（从未验证）→ error 级阻断。
      // （原实现靠自报 hasVerificationEvidence=false，该标志已退役。）
      const root = mkProject(false);
      try {
        const threw = await expectViolation(() =>
          checkConstraints({ ...PASSING_CTX, projectPath: root, changedFiles: [] })
        );
        expect(threw.result.id).toBe('no_completion_without_verification');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('验证证据新鲜度（1.15.0 证据源口径）', () => {
    it('证据早于最新变更 → 过期 fail 并点名晚于证据的变更文件', async () => {
      // 取代原「hasVerificationEvidence=false 触发」用例：新机制里能触发的
      // 两个真实形态是缺失/过期，过期分支另行覆盖（mtime 可控）。
      const root = mkProject(true);
      const staleEvidence = path.join(root, '.harness', 'evidence', 'vitest.log');
      const past = Date.now() / 1000 - 3600; // 证据回拨到 1 小时前
      fs.utimesSync(staleEvidence, past, past);
      fs.writeFileSync(path.join(root, 'late.ts'), 'export const x = 1;\n', 'utf-8');
      try {
        const threw = await expectViolation(() =>
          checkConstraints({ ...PASSING_CTX, projectPath: root, changedFiles: ['late.ts'] })
        );
        expect(threw.result.id).toBe('no_completion_without_verification');
        expect(JSON.stringify(threw.result)).toContain('late.ts');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('变更清单未接线（changedFiles 缺省）→ 显式降级 skip 不放行不违规', async () => {
      const root = mkProject(true);
      try {
        const result = await checkConstraints({ ...PASSING_CTX, projectPath: root });
        expect(result.passed).toBe(true);
        const item = result.errors.find(il => il.id === 'no_completion_without_verification');
        expect(item?.skipped).toBe(true);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('Studio 集成场景', () => {
    it('正常 dispatch 前检查通过', async () => {
      // 原用例指向 /root/projects/agent-studio（本机不存在的路径），旧口径靠
      // 自报标志放行；1.15.0 起证据源在 projectPath 下，改用带新鲜证据的 tmp 工程。
      const root = mkProject(true);
      try {
        const result = await checkConstraints({
          ...PASSING_CTX,
          projectPath: root,
          changedFiles: [],
          sessionId: 'test-execution-id',
        });
        expect(result.passed).toBe(true);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
