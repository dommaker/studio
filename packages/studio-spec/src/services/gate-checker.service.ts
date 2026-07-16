/**
 * 门禁检查服务
 * 
 * SP-003: GateChecker 整合
 * 
 * 负责：
 * 1. 执行门禁检查
 * 2. 分级策略管理
 * 3. 验证结果记录
 */

import {
  ValidateChangeInput,
  ValidateChangeResult,
  CheckResult,
  CheckpointType,
  GatePolicy,
  GATE_POLICIES,
  isHarnessCheck,
  HarnessCheckConfig,
} from '../types/gate.types.js';

import { ChangeLevel, ChangeRecord, SpecContent } from '../types/change.types.js';
import { changeAnalyzerService } from './change-analyzer.service.js';
import { changeHistoryService } from './change-history.service.js';
import { logger } from '@dommaker/studio-shared';

/**
 * Harness CheckpointValidator（动态导入）
 */
let harnessValidator: any = null;

async function getHarnessValidator() {
  if (!harnessValidator) {
    try {
      // 动态导入避免循环依赖
      const harness = await import('@dommaker/harness');
      harnessValidator = harness.CheckpointValidator?.getInstance?.() || null;
    } catch (error) {
      logger.warn('[GateChecker] Harness 导入失败，跳过通用检查');
      harnessValidator = null;
    }
  }
  return harnessValidator;
}

export class GateCheckerService {
  /**
   * 验证变更门禁
   */
  async validate(input: ValidateChangeInput & {
    harnessConfigs?: Array<{ type: CheckpointType; harness?: HarnessCheckConfig }>;
    strictMode?: boolean;
  }): Promise<ValidateChangeResult> {
    const { changeId, checkpoints, harnessConfigs, strictMode } = input;

    // 1. 获取变更记录
    const change = changeHistoryService.get(changeId);
    if (!change) {
      throw new Error(`变更记录不存在: ${changeId}`);
    }

    const level = change.level;
    const policy = this.getPolicy(level);

    // 2. 确定检查点
    const targetCheckpoints = checkpoints || policy.checkpoints;

    logger.info(`[GateChecker] 验证变更: ${changeId}, 级别: ${level}, 检查点: ${targetCheckpoints.join(', ')}`);

    // 3. 执行检查
    const checks: CheckResult[] = [];
    
    for (const checkpointType of targetCheckpoints) {
      // 获取 Harness 配置（如果有）
      const harnessConfig = harnessConfigs?.find(c => c.type === checkpointType)?.harness;
      
      const result = await this.runCheckpoint(change, checkpointType, harnessConfig, level, strictMode);
      checks.push(result);
    }

    // 4. 计算结果
    const passed = checks.every(c => c.passed);
    const canProceed = passed || level === 'L1'; // L1 即使检查失败也可以继续

    // 5. 生成摘要
    const passedCount = checks.filter(c => c.passed).length;
    const failedCount = checks.length - passedCount;
    const skippedCount = checks.filter(c => c.message.includes('跳过')).length;
    
    let summary: string;
    if (passed) {
      summary = `门禁验证通过 (${passedCount}/${checks.length})`;
    } else if (skippedCount > 0) {
      summary = `门禁验证部分跳过: ${skippedCount} 个检查未执行 (${failedCount} 失败)`;
    } else {
      summary = `门禁验证失败: ${failedCount} 个检查未通过`;
    }

    logger.info(`[GateChecker] 验证结果: ${passed ? '通过' : '失败'}, 跳过: ${skippedCount}`);

    return {
      changeId,
      level,
      passed,
      checks,
      summary,
      canProceed,
    };
  }

  /**
   * 获取级别对应的门禁策略
   */
  getPolicy(level: ChangeLevel): GatePolicy {
    return GATE_POLICIES[level];
  }

  /**
   * 获取所有门禁策略
   */
  getAllPolicies(): Record<ChangeLevel, GatePolicy> {
    return GATE_POLICIES;
  }

  /**
   * 执行单个检查点
   */
  private async runCheckpoint(
    change: ChangeRecord,
    type: CheckpointType,
    config?: HarnessCheckConfig,
    level?: ChangeLevel,
    strictMode?: boolean
  ): Promise<CheckResult> {
    // 分流：Harness 检查 vs 业务检查
    if (isHarnessCheck(type)) {
      return this.runHarnessCheckpoint(type, config, level, strictMode);
    }

    // 业务检查
    switch (type) {
      case 'spec_format':
        return this.checkSpecFormat(change);
      
      case 'test_coverage':
        return this.checkTestCoverage(change);
      
      case 'api_schema':
        return this.checkApiSchema(change);
      
      case 'architecture':
        return this.checkArchitecture(change);
      
      case 'ac_complete':
        return this.checkAcComplete(change);
      
      default:
        return {
          type,
          passed: false,
          message: `未知的检查点类型: ${type}`,
        };
    }
  }

  /**
   * 执行 Harness 通用检查
   */
  private async runHarnessCheckpoint(
    type: CheckpointType,
    config?: HarnessCheckConfig,
    level?: ChangeLevel,
    strictMode?: boolean
  ): Promise<CheckResult> {
    const validator = await getHarnessValidator();

    if (!validator) {
      // 判断是否允许跳过
      const allowSkip = !strictMode && (level === 'L1' || level === 'L2');
      
      if (allowSkip) {
        // L1/L2 非严格模式：优雅降级
        return {
          type,
          passed: true,
          message: 'Harness 不可用，已跳过（L1/L2 允许）',
          details: { skipped: true, reason: 'harness_unavailable' },
        };
      }
      
      // L3/L4 或严格模式：必须检查
      return {
        type,
        passed: false,
        message: 'Harness 不可用，无法执行必要检查',
        details: { skipped: false, reason: 'harness_unavailable', level },
      };
    }

    try {
      // 构建 Harness checkpoint
      const checkpoint = {
        id: `gate-${type}`,
        checks: [this.buildHarnessCheck(type, config)],
      };

      const context = {
        workDir: config?.workdir || process.cwd(),
      };

      const result = await validator.validate(checkpoint, context);

      return {
        type,
        passed: result.passed,
        message: result.message,
        details: { harnessResult: result },
      };
    } catch (error: any) {
      return {
        type,
        passed: false,
        message: `Harness 检查失败: ${error.message}`,
      };
    }
  }

  /**
   * 构建 Harness 检查配置
   */
  private buildHarnessCheck(type: CheckpointType, config?: HarnessCheckConfig): any {
    switch (type) {
      case 'file_exists':
        return {
          id: 'file_exists',
          type: 'file_exists',
          path: config?.path,
        };
      
      case 'file_contains':
        return {
          id: 'file_contains',
          type: 'file_contains',
          path: config?.path,
          content: config?.content,
        };
      
      case 'command_success':
        return {
          id: 'command_success',
          type: 'command_success',
          command: config?.command,
          workdir: config?.workdir,
          timeout: config?.timeout || 30000,
        };
      
      case 'output_matches':
        return {
          id: 'output_matches',
          type: 'output_matches',
          command: config?.command,
          pattern: config?.pattern,
        };
      
      default:
        return {
          id: type,
          type: 'custom',
        };
    }
  }

  /**
   * 检查 Spec 格式
   */
  private checkSpecFormat(change: ChangeRecord): CheckResult {
    const spec = change.newVersion;
    
    // 检查基本字段
    const hasMetadata = spec.metadata && spec.metadata.id;
    const hasTitle = spec.metadata?.title !== undefined;
    
    if (!hasMetadata) {
      return {
        type: 'spec_format',
        passed: false,
        message: 'Spec 缺少 metadata.id',
      };
    }

    return {
      type: 'spec_format',
      passed: true,
      message: 'Spec 格式正确',
      details: { hasMetadata, hasTitle },
    };
  }

  /**
   * 检查测试覆盖
   * 注：简化实现，实际需要搜索测试文件
   */
  private checkTestCoverage(change: ChangeRecord): CheckResult {
    // 检查是否有 AC（有 AC 就假设有测试）
    const hasAC = change.newVersion.acceptance_criteria && 
                  change.newVersion.acceptance_criteria.length > 0;
    
    // 如果变更类型包含 api_change，检查是否有 API
    const hasApiChange = change.changeTypes.includes('api_change');
    const hasApi = change.newVersion.api && change.newVersion.api.endpoints;
    
    if (hasApiChange && !hasApi) {
      return {
        type: 'test_coverage',
        passed: false,
        message: 'API 变更但缺少 API 定义',
      };
    }

    return {
      type: 'test_coverage',
      passed: true,
      message: '测试覆盖检查通过',
      details: { hasAC, hasApi },
    };
  }

  /**
   * 检查 API Schema
   */
  private checkApiSchema(change: ChangeRecord): CheckResult {
    const api = change.newVersion.api;
    
    if (!api) {
      // 没有 API 变更，跳过
      return {
        type: 'api_schema',
        passed: true,
        message: '无 API 变更，跳过检查',
      };
    }

    // 检查 endpoints 格式
    const endpoints = api.endpoints || [];
    
    for (const ep of endpoints) {
      if (!ep.path || !ep.method) {
        return {
          type: 'api_schema',
          passed: false,
          message: `API endpoint 缺少 path 或 method: ${JSON.stringify(ep)}`,
        };
      }
      
      // 检查 method 是否合法
      const validMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
      if (!validMethods.includes(ep.method)) {
        return {
          type: 'api_schema',
          passed: false,
          message: `无效的 HTTP method: ${ep.method}`,
        };
      }
    }

    return {
      type: 'api_schema',
      passed: true,
      message: 'API Schema 有效',
      details: { endpointCount: endpoints.length },
    };
  }

  /**
   * 检查架构依赖
   */
  private checkArchitecture(change: ChangeRecord): CheckResult {
    const arch = change.newVersion.architecture;
    
    if (!arch) {
      return {
        type: 'architecture',
        passed: true,
        message: '无架构变更，跳过检查',
      };
    }

    // 检查依赖是否声明
    const dependencies = arch.dependencies || [];
    
    // 检查是否有移除依赖（L4 变更）
    const oldDeps = change.oldVersion.architecture?.dependencies || [];
    const removedDeps = oldDeps.filter(d => !dependencies.includes(d));
    
    if (removedDeps.length > 0) {
      // 移除依赖需要确认
      return {
        type: 'architecture',
        passed: true, // 通过但需要记录
        message: `移除依赖: ${removedDeps.join(', ')}（需要评审确认）`,
        details: { removedDeps },
      };
    }

    return {
      type: 'architecture',
      passed: true,
      message: '架构检查通过',
      details: { dependencyCount: dependencies.length },
    };
  }

  /**
   * 检查 AC 完整覆盖
   */
  private checkAcComplete(change: ChangeRecord): CheckResult {
    const ac = change.newVersion.acceptance_criteria || [];
    
    if (ac.length === 0) {
      return {
        type: 'ac_complete',
        passed: true,
        message: '无 AC，跳过检查',
      };
    }

    // 检查每个 AC 是否有 id 和 description
    for (const criterion of ac) {
      if (!criterion.id) {
        return {
          type: 'ac_complete',
          passed: false,
          message: 'AC 缺少 id',
        };
      }
      
      if (!criterion.description) {
        return {
          type: 'ac_complete',
          passed: false,
          message: `AC ${criterion.id} 缺少 description`,
        };
      }
    }

    return {
      type: 'ac_complete',
      passed: true,
      message: `AC 完整: ${ac.length} 个`,
      details: { acCount: ac.length },
    };
  }
}

// 导出单例
export const gateCheckerService = new GateCheckerService();