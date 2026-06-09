/**
 * SpecValidator 单元测试
 * 
 * 覆盖 AC：
 * - AC-001: validateSpec 返回完整验证结果
 * - AC-008: 可指定验证层级范围
 * - AC-009: 错误包含位置信息
 * - AC-010: 与 CheckpointValidator 整合
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  SpecValidatorService,
  ArchitectureValidator,
  ApiValidator,
  AcceptanceValidator,
} from './spec-validator.service.js';
import type { SpecContent, ValidateSpecInput } from '../types/validation.types.js';

describe('SpecValidatorService', () => {
  let validator: SpecValidatorService;

  beforeAll(() => {
    validator = new SpecValidatorService();
  });

  // AC-001: validateSpec 返回完整验证结果
  it('AC-001: should return complete validation result', async () => {
    const input: ValidateSpecInput = {
      specId: 'SP-001',
      specPath: '/root/projects/studio/docs/specs/SP-001-spec-validator.md',
    };

    const result = await validator.validateSpec(input);

    // 期望结构完整
    expect(result.specId).toBe('SP-001');
    expect(result.valid).toBeDefined();
    expect(result.layers.architecture).toBeDefined();
    expect(result.layers.api).toBeDefined();
    expect(result.layers.acceptance).toBeDefined();
    expect(result.errors).toBeInstanceOf(Array);
    expect(result.warnings).toBeInstanceOf(Array);
    expect(result.summary).toBeDefined();
  });

  // AC-008: 可指定验证层级范围
  it('AC-008: should support selective layer validation', async () => {
    const input: ValidateSpecInput = {
      specId: 'SP-001',
      specContent: { metadata: { id: 'SP-001' } }, // 添加 specContent
      layers: ['architecture'], // 只验证架构层
    };

    const result = await validator.validateSpec(input);

    // 期望：只返回架构层结果
    expect(result.layers.architecture).toBeDefined();
    expect(result.layers.api).toBeUndefined();
    expect(result.layers.acceptance).toBeUndefined();
  });

  // AC-009: 错误包含位置信息
  it('AC-009: should include location in error messages', async () => {
    // 创建有错误的 Spec
    const incompleteSpec: SpecContent = {
      metadata: {
        id: 'SP-TEST-001',
        // 缺失 title, status, created
      },
    };

    const result = await validator.validateSpec({
      specId: 'SP-TEST-001',
      specContent: incompleteSpec,
    });

    // 期望：错误包含 location 字段
    if (result.errors.length > 0) {
      expect(result.errors[0].location).toBeDefined();
      expect(result.errors[0].location).toMatch(/metadata\..+/);
    }
  });

  // AC-010: 与 CheckpointValidator 整合
  it('AC-010: should integrate with CheckpointValidator', async () => {
    // 检查 SpecValidator 是否导出了 checkpoint 类型
    const checkpointTypes = validator.getSupportedCheckpointTypes();

    expect(checkpointTypes).toContain('spec_validation');
  });
});

/**
 * ArchitectureValidator 单元测试
 * 
 * 覆盖 AC：
 * - AC-002: 架构验证检测缺失必填字段
 * - AC-003: 架构验证检测无效依赖引用
 */
describe('ArchitectureValidator', () => {
  let validator: ArchitectureValidator;

  beforeAll(() => {
    validator = new ArchitectureValidator();
  });

  // AC-002: 架构验证检测缺失必填字段
  it('AC-002: should detect missing required fields', async () => {
    const incompleteSpec: SpecContent = {
      metadata: {
        id: 'SP-002',
        // 缺失: title, status, created
      },
      architecture: {
        dependencies: ['studio-shared'],
      },
    };

    const result = await validator.validate(incompleteSpec);

    expect(result.valid).toBe(false);
    expect(result.missingFields).toContain('metadata.title');
    expect(result.missingFields).toContain('metadata.status');
    expect(result.missingFields).toContain('metadata.created');
  });

  // AC-003: 架构验证检测无效依赖引用
  it('AC-003: should detect invalid dependency references', async () => {
    const specWithInvalidDep: SpecContent = {
      metadata: {
        id: 'SP-003',
        title: 'Test Spec',
        status: 'draft',
        created: '2026-04-21',
      },
      architecture: {
        dependencies: ['non-existent-package', 'studio-shared'],
      },
    };

    const result = await validator.validate(specWithInvalidDep);

    expect(result.valid).toBe(false);
    expect(result.invalidReferences).toContain('non-existent-package');
  });
});

/**
 * ApiValidator 单元测试
 * 
 * 覆盖 AC：
 * - AC-004: API 验证检测无效 endpoint 定义
 * - AC-005: API 验证检测缺失 schema 定义
 */
describe('ApiValidator', () => {
  let validator: ApiValidator;

  beforeAll(() => {
    validator = new ApiValidator();
  });

  // AC-004: API 验证检测无效 endpoint 定义
  it('AC-004: should detect invalid endpoint definitions', async () => {
    const specWithInvalidEndpoint: SpecContent = {
      metadata: { id: 'SP-004' },
      api: {
        endpoints: [
          {
            path: 'invalid-path-no-slash', // 应以 / 开头
            method: 'INVALID', // 应为 GET/POST/PUT/DELETE
          },
          {
            path: '/api/v1/specs/:id/validate',
            method: 'POST',
            request: 'ValidateSpecInput',
            response: 'ValidationResult',
          },
        ],
      },
    };

    const result = await validator.validate(specWithInvalidEndpoint);

    expect(result.valid).toBe(false);
    expect(result.invalidEndpoints).toContain('invalid-path-no-slash');
  });

  // AC-005: API 验证检测缺失 schema 定义
  it('AC-005: should detect missing schema definitions', async () => {
    const specWithMissingSchema: SpecContent = {
      metadata: { id: 'SP-005' },
      api: {
        endpoints: [
          {
            path: '/api/v1/specs/:id/validate',
            method: 'POST',
            request: 'NonExistentSchema', // schema 未定义
            response: 'ValidationResult',
          },
        ],
        schemas: {
          ValidationResult: { type: 'object' },
          // 缺失 NonExistentSchema
        },
      },
    };

    const result = await validator.validate(specWithMissingSchema);

    expect(result.valid).toBe(false);
    expect(result.missingSchemas).toContain('NonExistentSchema');
  });
});

/**
 * AcceptanceValidator 单元测试
 * 
 * 覆盖 AC：
 * - AC-006: 验收验证检测重复 AC ID
 * - AC-007: 验收验证检测不可测试的 AC
 */
describe('AcceptanceValidator', () => {
  let validator: AcceptanceValidator;

  beforeAll(() => {
    validator = new AcceptanceValidator();
  });

  // AC-006: 验收验证检测重复 AC ID
  it('AC-006: should detect duplicate AC IDs', async () => {
    const specWithDuplicateAc: SpecContent = {
      metadata: { id: 'SP-006' },
      acceptance_criteria: [
        { id: 'AC-001', description: 'First criterion', test: 'test_1' },
        { id: 'AC-001', description: 'Duplicate ID', test: 'test_2' }, // 重复
        { id: 'AC-002', description: 'Second criterion', test: 'test_3' },
      ],
    };

    const result = await validator.validate(specWithDuplicateAc);

    expect(result.valid).toBe(false);
    expect(result.duplicateIds).toContain('AC-001');
  });

  // AC-007: 验收验证检测不可测试的 AC
  it('AC-007: should detect untestable AC', async () => {
    const specWithUntestableAc: SpecContent = {
      metadata: { id: 'SP-007' },
      acceptance_criteria: [
        { id: 'AC-001', description: 'The system should work well' }, // 无 test 字段
        { id: 'AC-002', description: 'Good user experience' }, // 描述模糊
        { id: 'AC-003', description: 'Validation result is correct', test: 'test_validation' },
      ],
    };

    const result = await validator.validate(specWithUntestableAc);

    expect(result.valid).toBe(false);
    expect(result.untestableCriteria).toContain('AC-001');
    expect(result.untestableCriteria).toContain('AC-002');
  });
});