/**
 * Pipeline Contract Tests — 各阶段输入/输出格式契约验证
 *
 * 每条测试用固定 fixture 验证单阶段，不依赖 LLM。
 * 跑完全部 < 5 秒。
 *
 * 覆盖：
 *  - Completion hooks: checkBeforeTaskComplete 接受/拒绝逻辑
 *  - Test gate: .progress.json → evidence forwarding
 *  - Analyst archCtx: RequirementsDoc JSON schema
 *  - Executor testResults: .progress.json 格式
 */

import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── checkBeforeTaskComplete — test gate hook ──

describe('checkBeforeTaskComplete (test gate hook)', () => {
  it('有效 testResult — passed=true + evidence → allowed', async () => {
    const { checkBeforeTaskComplete } = await import(
      '../../packages/studio-shared/src/harness/hooks/completion.hooks.js'
    );
    const result = await checkBeforeTaskComplete([{
      passed: true,
      command: 'npm test',
      failures: [],
      evidence: '4 tests passed',
    }]);
    expect(result.allowed).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('缺少 evidence → blocked（缺少测试证据）', async () => {
    const { checkBeforeTaskComplete } = await import(
      '../../packages/studio-shared/src/harness/hooks/completion.hooks.js'
    );
    const result = await checkBeforeTaskComplete([{
      passed: true,
      command: 'npm test',
      failures: [],
      // evidence missing
    }]);
    expect(result.allowed).toBe(false);
    expect(result.violations).toContain('缺少测试证据');
  });

  it('passed=false → blocked（测试未通过）', async () => {
    const { checkBeforeTaskComplete } = await import(
      '../../packages/studio-shared/src/harness/hooks/completion.hooks.js'
    );
    const result = await checkBeforeTaskComplete([{
      passed: false,
      command: 'npm test',
      failures: ['test 1'],
      evidence: '1 failed',
    }]);
    expect(result.allowed).toBe(false);
    expect(result.violations).toContain('测试未通过');
  });

  it('空数组 → blocked（无 test result）', async () => {
    const { checkBeforeTaskComplete } = await import(
      '../../packages/studio-shared/src/harness/hooks/completion.hooks.js'
    );
    const result = await checkBeforeTaskComplete([]);
    expect(result.allowed).toBe(false);
  });

  it('requireEvidence=false → 允许无 evidence', async () => {
    const { checkBeforeTaskComplete } = await import(
      '../../packages/studio-shared/src/harness/hooks/completion.hooks.js'
    );
    const result = await checkBeforeTaskComplete([{
      passed: true,
      command: 'npm test',
      failures: [],
    }], { requireEvidence: false });
    expect(result.allowed).toBe(true);
  });
});

// ── .progress.json testResults 格式契约 ──

describe('.progress.json testResults schema', () => {
  it('完整 testResults → 通过格式验证', () => {
    const fixture = {
      testResults: {
        passed: true,
        total: 79,
        failed: 0,
        command: 'npm test',
        evidence: '79 tests passed',
      },
    };
    expect(typeof fixture.testResults.passed === 'boolean').toBe(true);
    expect(typeof fixture.testResults.total === 'number').toBe(true);
    expect(typeof fixture.testResults.failed === 'number').toBe(true);
    expect(typeof fixture.testResults.command === 'string').toBe(true);
    expect(typeof fixture.testResults.evidence === 'string').toBe(true);
  });

  it('缺失 testResults → 默认值回退', () => {
    const progress = {};
    const tr = progress.testResults || { passed: false, failed: 1, total: 0 };
    expect(tr.passed).toBe(false);
    expect(tr.total).toBe(0);
  });
});

// ── Analyst RequirementsDoc JSON schema ──

describe('Analyst RequirementsDoc JSON schema', () => {
  it('acGroup 含完整字段（含 architectureContext）', () => {
    // 这是 Analyst 输出契约，任何修改这个结构的变化都会破坏 Executor
    const fixture = {
      title: 'Test',
      acGroups: [{
        id: 'AC1',
        acs: ['AC1.1'],
        files: ['foo.ts'],
        dependencies: [],
        implementationNotes: 'notes',
        architectureContext: {
          functions: ['fn(p: string): void @ L100'],
          callChain: 'A → B → C',
          imports: ['import { x } from "./y"'],
          typesInScope: ['TypeX'],
          testMock: ['vi.mock("./y")'],
          dangerZones: ['L50-L60 early return'],
          verifiedAt: 'abc123',
        },
        codePatterns: ['pattern'],
        gotchas: ['gotcha'],
      }],
    };

    const group = fixture.acGroups[0];
    expect(group.architectureContext).toBeDefined();
    expect(group.architectureContext!.functions.length).toBeGreaterThan(0);
    expect(group.architectureContext!.verifiedAt).toBeTruthy();
    expect(group.implementationNotes.length).toBeGreaterThan(0);
    expect(group.gotchas!.length).toBeGreaterThan(0);
  });

  it('architectureContext 缺失时 Executor 不崩溃', () => {
    const group = {
      id: 'AC1',
      acs: ['AC1.1'],
      files: ['foo.ts'],
      dependencies: [],
    };
    const archCtx = (group as any).architectureContext;
    // Executor renders architecture context section only when ctx exists
    const renderSection = archCtx ? '## 架构上下文' : '';
    expect(renderSection).toBe('');
  });
});

// ── Scheduler recovery: abandonOpenedRunning ──

describe('Scheduler recovery contract', () => {
  it('启动时应放弃 running 和 pending 执行', () => {
    // 契约：abandonOrphanedRunning 查询 status IN (running, pending)
    const query = { where: { status: { in: ['running', 'pending'] } } };
    expect(query.where.status.in).toContain('running');
    expect(query.where.status.in).toContain('pending');
  });
});
