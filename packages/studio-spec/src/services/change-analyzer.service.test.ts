/**
 * ChangeAnalyzerService 单元测试
 * 
 * 覆盖 AC：
 * - AC-001: L1 变更自动判定正确
 * - AC-002: L2 变更自动判定正确
 * - AC-003: L3 变更自动判定正确
 * - AC-004: L4 变更自动判定正确
 * - AC-005: 风险评分计算正确
 * - AC-006: L1 变更无需审批
 * - AC-007: L2 变更自动审批
 * - AC-008: L3 变更单人审批
 * - AC-009: L4 变更会议评审
 * - AC-010: 变更历史记录完整（待实现 change-history.service）
 */

import { describe, it, expect } from 'vitest';
import { ChangeAnalyzerService } from './change-analyzer.service.js';
import type { SpecContent } from '../types/change.types.js';

const analyzer = new ChangeAnalyzerService();

// 测试用的基础 Spec
const baseSpec: SpecContent = {
  metadata: {
    id: 'test-spec-001',
    title: 'Test Spec',
    status: 'draft',
    created: '2026-04-21',
    updated: '2026-04-21',
  },
  architecture: {
    dependencies: ['studio-shared', 'studio-prisma'],
    data_models: ['Company', 'CompanySkill'],
  },
  api: {
    endpoints: [
      { path: '/api/v1/skills', method: 'GET' },
      { path: '/api/v1/skills/:id', method: 'GET' },
    ],
    schemas: {},
  },
  acceptance_criteria: [
    { id: 'AC-001', description: '创建技能成功' },
    { id: 'AC-002', description: '技能名唯一' },
    { id: 'AC-003', description: '查询列表正确' },
  ],
};

describe('ChangeAnalyzerService', () => {
  // AC-001: L1 变更自动判定正确
  it('AC-001: should detect L1 change (typo fix)', async () => {
    const newSpec: SpecContent = {
      ...baseSpec,
      metadata: {
        ...baseSpec.metadata,
        title: 'Test Spec (typo fix)',
      },
    };

    const result = await analyzer.analyze({
      specId: 'test-spec-001',
      oldVersion: baseSpec,
      newVersion: newSpec,
    });

    expect(result.level).toBe('L1');
    expect(result.changeTypes).toContain('typo_fix');
    expect(result.affectedAreas).toContain('metadata');
    expect(result.recommendedApproval.type).toBe('auto');
    expect(result.recommendedApproval.description).toBe('自动通过');
  });

  // AC-001b: metadata sync 也是 L1
  it('AC-001b: should detect L1 change (metadata sync)', async () => {
    const newSpec: SpecContent = {
      ...baseSpec,
      metadata: {
        ...baseSpec.metadata,
        status: 'in_progress',
        updated: '2026-04-22',
      },
    };

    const result = await analyzer.analyze({
      specId: 'test-spec-001',
      oldVersion: baseSpec,
      newVersion: newSpec,
    });

    expect(result.level).toBe('L1');
    expect(result.changeTypes).toContain('metadata_sync');
  });

  // AC-002: L2 变更自动判定正确
  it('AC-002: should detect L2 change (test_add)', async () => {
    const newSpec: SpecContent = {
      ...baseSpec,
      acceptance_criteria: [
        { id: 'AC-001', description: '创建技能成功', test: 'test_create_skill' },
        { id: 'AC-002', description: '技能名唯一', test: 'test_unique_name' },
        { id: 'AC-003', description: '查询列表正确' },
      ],
    };

    const result = await analyzer.analyze({
      specId: 'test-spec-001',
      oldVersion: baseSpec,
      newVersion: newSpec,
    });

    expect(result.level).toBe('L2');
    expect(result.changeTypes).toContain('test_add');
    expect(result.recommendedApproval.type).toBe('gate_checker');
    expect(result.recommendedApproval.description).toBe('GateChecker 自动验证');
  });

  // AC-002b: AC 顺序调整也是 L2
  it('AC-002b: should detect L2 change (ac_reorder)', async () => {
    const newSpec: SpecContent = {
      ...baseSpec,
      acceptance_criteria: [
        { id: 'AC-003', description: '查询列表正确' },
        { id: 'AC-001', description: '创建技能成功' },
        { id: 'AC-002', description: '技能名唯一' },
      ],
    };

    const result = await analyzer.analyze({
      specId: 'test-spec-001',
      oldVersion: baseSpec,
      newVersion: newSpec,
    });

    expect(result.level).toBe('L2');
    expect(result.changeTypes).toContain('ac_reorder');
  });

  // AC-003: L3 变更自动判定正确
  it('AC-003: should detect L3 change (api_change)', async () => {
    const newSpec: SpecContent = {
      ...baseSpec,
      api: {
        endpoints: [
          { path: '/api/v1/skills', method: 'GET' },
          { path: '/api/v1/skills/:id', method: 'GET' },
          { path: '/api/v1/skills', method: 'POST' }, // 新增 endpoint
        ],
        schemas: {},
      },
    };

    const result = await analyzer.analyze({
      specId: 'test-spec-001',
      oldVersion: baseSpec,
      newVersion: newSpec,
    });

    expect(result.level).toBe('L3');
    expect(result.changeTypes).toContain('api_change');
    expect(result.recommendedApproval.type).toBe('single_approval');
    expect(result.recommendedApproval.requiredApprovers).toBe(1);
  });

  // AC-003b: dependency_add 也是 L3
  it('AC-003b: should detect L3 change (dependency_add)', async () => {
    const newSpec: SpecContent = {
      ...baseSpec,
      architecture: {
        dependencies: ['studio-shared', 'studio-prisma', 'studio-capability'],
        data_models: ['Company', 'CompanySkill'],
      },
    };

    const result = await analyzer.analyze({
      specId: 'test-spec-001',
      oldVersion: baseSpec,
      newVersion: newSpec,
    });

    expect(result.level).toBe('L3');
    expect(result.changeTypes).toContain('dependency_add');
  });

  // AC-004: L4 变更自动判定正确
  it('AC-004: should detect L4 change (dependency_remove)', async () => {
    const newSpec: SpecContent = {
      ...baseSpec,
      architecture: {
        dependencies: ['studio-shared'], // 移除 studio-prisma
        data_models: ['Company', 'CompanySkill'],
      },
    };

    const result = await analyzer.analyze({
      specId: 'test-spec-001',
      oldVersion: baseSpec,
      newVersion: newSpec,
    });

    expect(result.level).toBe('L4');
    expect(result.changeTypes).toContain('dependency_remove');
    expect(result.recommendedApproval.type).toBe('meeting_review');
    expect(result.recommendedApproval.requiredApprovers).toBe(3);
  });

  // AC-004b: ac_remove 也是 L4
  it('AC-004b: should detect L4 change (ac_remove)', async () => {
    const newSpec: SpecContent = {
      ...baseSpec,
      acceptance_criteria: [
        { id: 'AC-001', description: '创建技能成功' },
        { id: 'AC-002', description: '技能名唯一' },
        // 移除 AC-003
      ],
    };

    const result = await analyzer.analyze({
      specId: 'test-spec-001',
      oldVersion: baseSpec,
      newVersion: newSpec,
    });

    expect(result.level).toBe('L4');
    expect(result.changeTypes).toContain('ac_remove');
  });

  // AC-005: 风险评分计算正确
  it('AC-005: should calculate risk score correctly', async () => {
    // L1 变更：风险评分应该较低
    const l1Spec: SpecContent = {
      ...baseSpec,
      metadata: { ...baseSpec.metadata, title: 'Test Spec (typo fix)' },
    };
    const l1Result = await analyzer.analyze({
      specId: 'test-spec-001',
      oldVersion: baseSpec,
      newVersion: l1Spec,
    });
    expect(l1Result.riskScore).toBeLessThan(50);

    // L4 变更：风险评分应该较高
    const l4Spec: SpecContent = {
      ...baseSpec,
      architecture: { dependencies: ['studio-shared'] },
    };
    const l4Result = await analyzer.analyze({
      specId: 'test-spec-001',
      oldVersion: baseSpec,
      newVersion: l4Spec,
    });
    expect(l4Result.riskScore).toBeGreaterThanOrEqual(50);
  });

  // AC-005b: 风险评分在 0-100 范围
  it('AC-005b: risk score should be in 0-100 range', async () => {
    // 无变更
    const noChangeResult = await analyzer.analyze({
      specId: 'test-spec-001',
      oldVersion: baseSpec,
      newVersion: baseSpec,
    });
    expect(noChangeResult.riskScore).toBeGreaterThanOrEqual(0);
    expect(noChangeResult.riskScore).toBeLessThanOrEqual(100);

    // 多变更
    const multiChangeSpec: SpecContent = {
      ...baseSpec,
      metadata: { ...baseSpec.metadata, title: 'New Title' },
      architecture: { dependencies: ['studio-shared'] },
      acceptance_criteria: [{ id: 'AC-001', description: '创建技能成功' }],
    };
    const multiResult = await analyzer.analyze({
      specId: 'test-spec-001',
      oldVersion: baseSpec,
      newVersion: multiChangeSpec,
    });
    expect(multiResult.riskScore).toBeGreaterThanOrEqual(0);
    expect(multiResult.riskScore).toBeLessThanOrEqual(100);
  });

  // AC-006: L1 变更无需审批
  it('AC-006: L1 change should have auto approval', async () => {
    const newSpec: SpecContent = {
      ...baseSpec,
      metadata: {
        ...baseSpec.metadata,
        status: 'completed',
        updated: '2026-04-22',
      },
    };

    const result = await analyzer.analyze({
      specId: 'test-spec-001',
      oldVersion: baseSpec,
      newVersion: newSpec,
    });

    expect(result.level).toBe('L1');
    expect(result.recommendedApproval.type).toBe('auto');
    expect(result.recommendedApproval.estimatedTime).toBe('立即');
  });

  // AC-007: L2 变更自动审批
  it('AC-007: L2 change should have gate_checker approval', async () => {
    const newSpec: SpecContent = {
      ...baseSpec,
      acceptance_criteria: [
        { id: 'AC-001', description: '创建技能成功', test: 'test_create' },
        { id: 'AC-002', description: '技能名唯一' },
        { id: 'AC-003', description: '查询列表正确' },
      ],
    };

    const result = await analyzer.analyze({
      specId: 'test-spec-001',
      oldVersion: baseSpec,
      newVersion: newSpec,
    });

    expect(result.level).toBe('L2');
    expect(result.recommendedApproval.type).toBe('gate_checker');
    expect(result.recommendedApproval.estimatedTime).toBe('< 5min');
  });

  // AC-008: L3 变更单人审批
  it('AC-008: L3 change should have single approval', async () => {
    const newSpec: SpecContent = {
      ...baseSpec,
      api: {
        endpoints: [
          { path: '/api/v1/skills/:id', method: 'DELETE' }, // 新增
        ],
        schemas: {},
      },
    };

    const result = await analyzer.analyze({
      specId: 'test-spec-001',
      oldVersion: baseSpec,
      newVersion: newSpec,
    });

    expect(result.level).toBe('L3');
    expect(result.recommendedApproval.type).toBe('single_approval');
    expect(result.recommendedApproval.requiredApprovers).toBe(1);
    expect(result.recommendedApproval.estimatedTime).toBe('< 1h');
  });

  // AC-009: L4 变更会议评审
  it('AC-009: L4 change should have meeting review', async () => {
    const newSpec: SpecContent = {
      ...baseSpec,
      architecture: {
        dependencies: [], // 移除所有依赖
        data_models: [],
      },
    };

    const result = await analyzer.analyze({
      specId: 'test-spec-001',
      oldVersion: baseSpec,
      newVersion: newSpec,
    });

    expect(result.level).toBe('L4');
    expect(result.recommendedApproval.type).toBe('meeting_review');
    expect(result.recommendedApproval.requiredApprovers).toBe(3);
    expect(result.recommendedApproval.estimatedTime).toBe('< 24h');
  });

  // 边界测试：混合变更级别（取最高）
  it('should use highest level for mixed changes', async () => {
    const newSpec: SpecContent = {
      ...baseSpec,
      metadata: { ...baseSpec.metadata, title: 'Test Spec (typo fix)' }, // L1
      architecture: { dependencies: ['studio-shared'] }, // L4
    };

    const result = await analyzer.analyze({
      specId: 'test-spec-001',
      oldVersion: baseSpec,
      newVersion: newSpec,
    });

    // 应取最高级别 L4
    expect(result.level).toBe('L4');
    expect(result.changeTypes).toContain('typo_fix');
    expect(result.changeTypes).toContain('dependency_remove');
  });

  // 边界测试：无变更
  it('should return L1 for no changes', async () => {
    const result = await analyzer.analyze({
      specId: 'test-spec-001',
      oldVersion: baseSpec,
      newVersion: baseSpec,
    });

    expect(result.level).toBe('L1');
    expect(result.changeTypes).toHaveLength(0);
    expect(result.summary).toContain('无变更');
  });
});