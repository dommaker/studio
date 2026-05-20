/**
 * SpecValidator 主服务
 *
 * 整合三层验证：architecture + api + acceptance
 */

import { existsSync } from 'fs';
import { parseSpecMarkdown } from '@dommaker/studio-shared';
import { ArchitectureValidator } from './architecture-validator.js';
import { ApiValidator } from './api-validator.js';
import { AcceptanceValidator } from './acceptance-validator.js';
import type {
  ValidateSpecInput,
  ValidationResult,
  ValidationError,
  ValidationWarning,
  LayerResult,
  SpecContent,
} from '../types/validation.types.js';

export class SpecValidatorService {
  private architectureValidator: ArchitectureValidator;
  private apiValidator: ApiValidator;
  private acceptanceValidator: AcceptanceValidator;

  constructor() {
    this.architectureValidator = new ArchitectureValidator();
    this.apiValidator = new ApiValidator();
    this.acceptanceValidator = new AcceptanceValidator();
  }

  /**
   * 综合验证 Spec
   */
  async validateSpec(input: ValidateSpecInput): Promise<ValidationResult> {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    // 获取 Spec 内容
    let spec: SpecContent;
    if (input.specContent) {
      spec = input.specContent;
    } else if (input.specPath) {
      spec = await this.loadSpec(input.specPath);
    } else {
      throw new Error('需要 specPath 或 specContent');
    }

    // 确定验证层级
    const layers = input.layers || ['architecture', 'api', 'acceptance'];

    // 执行各层验证
    const layerResults: { architecture?: LayerResult; api?: LayerResult; acceptance?: LayerResult } = {};

    if (layers.includes('architecture')) {
      const archResult = await this.architectureValidator.validate(spec);
      layerResults.architecture = {
        valid: archResult.valid,
        checks: archResult.checks,
      };

      // 收集错误
      for (const field of archResult.missingFields) {
        errors.push({
          layer: 'architecture',
          checkId: `arch-missing-${field}`,
          message: `缺失必填字段: ${field}`,
          location: field,
          severity: 'error',
        });
      }

      for (const ref of archResult.invalidReferences) {
        errors.push({
          layer: 'architecture',
          checkId: `arch-invalid-${ref}`,
          message: `无效依赖引用: ${ref}`,
          location: `architecture.dependencies.${ref}`,
          severity: 'error',
        });
      }
    }

    if (layers.includes('api')) {
      const apiResult = await this.apiValidator.validate(spec);
      layerResults.api = {
        valid: apiResult.valid,
        checks: apiResult.checks,
      };

      for (const endpoint of apiResult.invalidEndpoints) {
        errors.push({
          layer: 'api',
          checkId: `api-invalid-${endpoint}`,
          message: `无效 endpoint: ${endpoint}`,
          location: `api.endpoints.${endpoint}`,
          severity: 'error',
        });
      }

      for (const schema of apiResult.missingSchemas) {
        errors.push({
          layer: 'api',
          checkId: `api-missing-${schema}`,
          message: `缺失 schema: ${schema}`,
          location: `api.schemas.${schema}`,
          severity: 'error',
        });
      }
    }

    if (layers.includes('acceptance')) {
      const accResult = await this.acceptanceValidator.validate(spec);
      layerResults.acceptance = {
        valid: accResult.valid,
        checks: accResult.checks,
      };

      for (const id of accResult.duplicateIds) {
        errors.push({
          layer: 'acceptance',
          checkId: `acc-duplicate-${id}`,
          message: `AC ID 重复: ${id}`,
          location: `acceptance_criteria.${id}`,
          severity: 'error',
        });
      }

      for (const id of accResult.untestableCriteria) {
        warnings.push({
          layer: 'acceptance',
          checkId: `acc-untestable-${id}`,
          message: `AC 不可测试: ${id}`,
          location: `acceptance_criteria.${id}`,
        });
      }
    }

    // 计算总体有效性
    const valid = Object.values(layerResults).every(r => r?.valid !== false);

    // 生成摘要
    const summary = this.generateSummary(valid, errors, warnings);

    return {
      specId: input.specId,
      valid,
      layers: layerResults,
      errors,
      warnings,
      summary,
    };
  }

  /**
   * 加载 Spec 文件（Markdown 格式）
   * 使用共享解析器 @see parseSpecMarkdown
   */
  private async loadSpec(specPath: string): Promise<SpecContent> {
    if (!existsSync(specPath)) {
      throw new Error(`Spec 文件不存在: ${specPath}`);
    }

    const content = await import('fs').then(fs => fs.readFileSync(specPath, 'utf-8'));
    return parseSpecMarkdown(content, specPath);
  }

  /**
   * 生成验证摘要
   */
  private generateSummary(valid: boolean, errors: ValidationError[], warnings: ValidationWarning[]): string {
    if (valid) {
      return `Spec 验证通过，${warnings.length} 个警告`;
    }

    return `Spec 验证失败，${errors.length} 个错误，${warnings.length} 个警告`;
  }

  /**
   * 获取支持的 checkpoint 类型
   */
  getSupportedCheckpointTypes(): string[] {
    return ['spec_validation'];
  }
}

// 导出子验证器（用于测试）
export { ArchitectureValidator } from './architecture-validator.js';
export { ApiValidator } from './api-validator.js';
export { AcceptanceValidator } from './acceptance-validator.js';