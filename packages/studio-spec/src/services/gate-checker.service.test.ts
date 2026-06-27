/**
 * GateCheckerService 单元测试
 * 
 * SP-003: GateChecker 整合
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = new Map<string, any>();
let nextId = 1;

vi.mock('@prisma/client', () => {
  return {
    PrismaClient: class {
      specChangeRequest = {
        create: async ({ data }: any) => {
          const id = `mock-${nextId++}`;
          const record = { ...data, id, submittedAt: new Date(), appliedAt: null };
          store.set(id, record);
          return record;
        },
        findUnique: async ({ where }: any) => store.get(where.id) ?? null,
        findFirst: async () => null,
        update: async ({ where, data }: any) => {
          const record = store.get(where.id);
          if (record) Object.assign(record, data);
          return record;
        },
        findMany: async () => [...store.values()],
      };
    },
    Prisma: { ModelName: {} },
  };
});

import { GateCheckerService, gateCheckerService } from './gate-checker.service.js';
import { changeApproverService } from './change-approver.service.js';
import { isHarnessCheck } from '../types/gate.types.js';
import type { SpecContent } from '../types/gate.types.js';

describe('GateCheckerService', () => {
  beforeEach(() => {
    store.clear();
    nextId = 1;
  });

  // AC-001: L1 变更无需门禁验证
  it('AC-001: L1 change should have no gate', async () => {
    const policy = gateCheckerService.getPolicy('L1');
    
    expect(policy.checkpoints.length).toBe(0);
    expect(policy.autoApprove).toBe(true);
    expect(policy.requiresHumanReview).toBe(false);
  });

  // AC-002: L2 变更自动门禁验证
  it('AC-002: L2 change should have auto gate', async () => {
    const policy = gateCheckerService.getPolicy('L2');
    
    expect(policy.checkpoints).toContain('spec_format');
    expect(policy.checkpoints).toContain('test_coverage');
    expect(policy.autoApprove).toBe(true);
    expect(policy.requiresHumanReview).toBe(false);
  });

  // AC-003: L3 变更门禁 + 审批
  it('AC-003: L3 change should have gate + approval', async () => {
    const policy = gateCheckerService.getPolicy('L3');
    
    expect(policy.checkpoints).toContain('spec_format');
    expect(policy.checkpoints).toContain('test_coverage');
    expect(policy.checkpoints).toContain('api_schema');
    expect(policy.checkpoints).toContain('ac_complete');
    expect(policy.autoApprove).toBe(false);
    expect(policy.requiresHumanReview).toBe(true);
  });

  // AC-004: L4 变更完整门禁
  it('AC-004: L4 change should have full gate', async () => {
    const policy = gateCheckerService.getPolicy('L4');
    
    expect(policy.checkpoints).toContain('spec_format');
    expect(policy.checkpoints).toContain('test_coverage');
    expect(policy.checkpoints).toContain('api_schema');
    expect(policy.checkpoints).toContain('architecture');
    expect(policy.checkpoints).toContain('ac_complete');
    expect(policy.autoApprove).toBe(false);
    expect(policy.requiresHumanReview).toBe(true);
  });

  // AC-005: 门禁失败阻止审批
  it('AC-005: failed gate should block approval', async () => {
    // 创建一个格式错误的 Spec
    const badSpec: SpecContent = {
      metadata: {
        id: 'spec-gate-fail',
        // 缺少 title
      },
      api: {
        endpoints: [
          { path: '/api/test', method: 'INVALID' }, // 无效 method
        ],
        schemas: {},
      },
    };

    const submitResult = await changeApproverService.submit({
      specId: 'spec-gate-fail',
      changeContent: badSpec as any,
      submittedBy: 'user-001',
    });

    const validateResult = await gateCheckerService.validate({
      changeId: submitResult.changeId,
    });

    expect(validateResult.passed).toBe(false);
    expect(validateResult.canProceed).toBe(false);
    
    // 检查失败的检查点
    const failedChecks = validateResult.checks.filter(c => !c.passed);
    expect(failedChecks.length).toBeGreaterThan(0);
  });

  // AC-006: 门禁策略可查询
  it('AC-006: should get all gate policies', () => {
    const policies = gateCheckerService.getAllPolicies();
    
    expect(policies.L1).toBeDefined();
    expect(policies.L2).toBeDefined();
    expect(policies.L3).toBeDefined();
    expect(policies.L4).toBeDefined();
  });

  // AC-007: 门禁结果记录（简化验证）
  it('AC-007: gate result should have summary', async () => {
    const goodSpec: SpecContent = {
      metadata: {
        id: 'spec-gate-pass',
        title: 'Test Spec',
      },
      acceptance_criteria: [
        { id: 'AC-001', description: '测试成功' },
      ],
    };

    const submitResult = await changeApproverService.submit({
      specId: 'spec-gate-pass',
      changeContent: goodSpec as any,
      submittedBy: 'user-001',
    });

    const validateResult = await gateCheckerService.validate({
      changeId: submitResult.changeId,
      checkpoints: ['spec_format', 'ac_complete'],
    });

    expect(validateResult.summary).toContain('通过');
    expect(validateResult.changeId).toBe(submitResult.changeId);
    expect(validateResult.level).toBeDefined();
  });

  // AC-008: 自定义检查点支持
  it('AC-008: should support custom checkpoints', async () => {
    const spec: SpecContent = {
      metadata: {
        id: 'spec-custom-check',
        title: 'Test',
      },
    };

    const submitResult = await changeApproverService.submit({
      specId: 'spec-custom-check',
      changeContent: spec as any,
      submittedBy: 'user-001',
    });

    // 使用自定义检查点（只检查 spec_format）
    const validateResult = await gateCheckerService.validate({
      changeId: submitResult.changeId,
      checkpoints: ['spec_format'],
    });

    expect(validateResult.checks.length).toBe(1);
    expect(validateResult.checks[0].type).toBe('spec_format');
  });

  // 严格模式测试（Harness 已安装，走真实验证路径）
  it('should run Harness check in strictMode', async () => {
    const spec: SpecContent = {
      metadata: { id: 'spec-strict', title: 'Test' },
    };

    const submitResult = await changeApproverService.submit({
      specId: 'spec-strict',
      changeContent: spec as any,
      submittedBy: 'user-001',
    });

    // strictMode + Harness 检查（Harness 已安装可用）
    const validateResult = await gateCheckerService.validate({
      changeId: submitResult.changeId,
      checkpoints: ['file_exists'],
      strictMode: true,
    });

    expect(validateResult.checks.length).toBeGreaterThan(0);
    const fileCheck = validateResult.checks.find(c => c.type === 'file_exists');
    expect(fileCheck).toBeDefined();
    expect(fileCheck!.type).toBe('file_exists');
    // 严格模式下 Harness 可用时检查正常运行，不跳过
  });

  // L1/L2 降级测试（Harness 已安装，走真实验证路径）
  it('should run Harness check for L1/L2 when Harness available', async () => {
    const spec: SpecContent = {
      metadata: { id: 'spec-l2-harness', title: 'Test' },
    };

    const submitResult = await changeApproverService.submit({
      specId: 'spec-l2-harness',
      changeContent: spec as any,
      submittedBy: 'user-001',
    });

    const validateResult = await gateCheckerService.validate({
      changeId: submitResult.changeId,
      checkpoints: ['file_exists'],
    });

    const fileCheck = validateResult.checks.find(c => c.type === 'file_exists');
    expect(fileCheck).toBeDefined();
    expect(fileCheck!.type).toBe('file_exists');
    // Harness 已安装在当前环境，检查应正常运行
  });

  // 检查类型判断
  it('should correctly identify Harness checks', () => {
    expect(isHarnessCheck('file_exists')).toBe(true);
    expect(isHarnessCheck('file_contains')).toBe(true);
    expect(isHarnessCheck('command_success')).toBe(true);
    expect(isHarnessCheck('output_matches')).toBe(true);
    expect(isHarnessCheck('spec_format')).toBe(false);
    expect(isHarnessCheck('ac_complete')).toBe(false);
  });

  // 不存在的变更应该报错
  it('should throw for non-existent change', async () => {
    await expect(gateCheckerService.validate({
      changeId: 'non-existent-id',
    })).rejects.toThrow('变更记录不存在');
  });
});