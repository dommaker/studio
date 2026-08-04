/**
 * 架构层验证器
 * 
 * 检查项：
 * - metadata 必填字段
 * - architecture.dependencies 有效性
 */

import type {
  SpecContent,
  ArchitectureValidationResult,
  CheckResult,
} from '../types/validation.types.js';
// Prisma removed (Spec 4 Phase 4). Data models now live in FileStore (~/.studio/).
// Architecture validation of data_model references requires FileStore scan (TODO: spec4-followup).
function getDataModelNames(): Set<string> {
  // FileStore models are document-based — scan ~/.studio/schemas/ if implemented
  return new Set<string>();
}

// 必填字段
const REQUIRED_METADATA_FIELDS = ['id', 'title', 'status', 'created'];

// 有效 HTTP 方法
const VALID_HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

export class ArchitectureValidator {
  /**
   * 验证 Spec 架构层
   */
  async validate(spec: SpecContent): Promise<ArchitectureValidationResult> {
    const checks: CheckResult[] = [];
    const missingFields: string[] = [];
    const invalidReferences: string[] = [];

    // 检查 1: metadata 必填字段
    for (const field of REQUIRED_METADATA_FIELDS) {
      const checkId = `arch-meta-${field}`;
      const hasField = spec.metadata && spec.metadata[field as keyof typeof spec.metadata] !== undefined;
      
      checks.push({
        checkId,
        description: `检查 metadata.${field} 是否存在`,
        passed: hasField,
        message: hasField ? undefined : `缺失必填字段 metadata.${field}`,
        location: hasField ? undefined : `metadata.${field}`,
      });

      if (!hasField) {
        missingFields.push(`metadata.${field}`);
      }
    }

    // 检查 2: architecture.dependencies 有效性
    if (spec.architecture?.dependencies) {
      for (const dep of spec.architecture.dependencies) {
        const checkId = `arch-dep-${dep}`;
        const isValid = await this.checkDependencyValid(dep);
        
        checks.push({
          checkId,
          description: `检查依赖 ${dep} 是否存在`,
          passed: isValid,
          message: isValid ? undefined : `依赖 ${dep} 不存在或无效`,
          location: isValid ? undefined : `architecture.dependencies.${dep}`,
        });

        if (!isValid) {
          invalidReferences.push(dep);
        }
      }
    }

    // 检查 3: architecture.data_models 有效性
    if (spec.architecture?.data_models) {
      const dataModels = getDataModelNames();
      for (const model of spec.architecture.data_models) {
        const checkId = `arch-model-${model}`;
        const exists = dataModels.has(model.toLowerCase());
        checks.push({
          checkId,
          description: `检查数据模型 ${model} 是否存在`,
          passed: exists,
          message: exists ? undefined : `模型 ${model} 在 FileStore schema 中未注册`,
        });
        if (!exists) {
          invalidReferences.push(model);
        }
      }
    }

    const valid = missingFields.length === 0 && invalidReferences.length === 0;

    return {
      valid,
      checks,
      missingFields,
      invalidReferences,
    };
  }

  /**
   * 检查依赖是否有效
   * 
   * 在 monorepo 中检查 package 是否存在
   */
  private async checkDependencyValid(dep: string): Promise<boolean> {
    // 已知的有效 packages
    const validPackages = [
      'studio-shared',
      'studio-prisma',
      'studio-notification',
      'studio-task',
      'studio-capability',
      'studio-monitor',
      'studio-agent',
      'studio-audit',
      'studio-spec',
    ];

    // 检查是否在已知 packages 中
    return validPackages.includes(dep);
  }
}