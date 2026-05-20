/**
 * 门禁检查器 - 重构版
 * 
 * 复用 @dommaker/harness 门禁能力：
 * - PassesGate（测试门控）
 * - SpecValidator（Spec 验证）
 * - ConstraintChecker（约束检查）
 * - CheckpointValidator（检查点验证）
 * - ReviewGate（审查门禁）
 * - SecurityGate（安全门禁）
 * - PerformanceGate（性能门禁）
 * - ContractGate（契约门禁）
 * - SpecAcceptanceGate（验收标准门禁）
 */

import type { ContextSharer } from './context-sharer';

// 从 @dommaker/harness 统一导入门禁
import { 
  PassesGate,
  SpecValidator,
  ConstraintChecker,
  CheckpointValidator,
  ReviewGate,
  SecurityGate, 
  PerformanceGate, 
  ContractGate,
  SpecAcceptanceGate,
} from '@dommaker/harness';

// 门禁绕过管理器
import { GateBypassManager, type BypassCheckResult } from './gate-bypass-manager';

// ==================== 类型定义 ====================

export type GateType = 'test' | 'spec' | 'checkpoint' | 'review' | 'contract' | 'security' | 'performance' | 'acceptance';

export type GateStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

export interface GateResult {
  gate: GateType;
  passed: boolean;
  status: GateStatus;
  message: string;
  details?: Record<string, any>;
  timestamp: string;
  duration?: number;
}

export interface GateCheckContext {
  meetingId: string;
  taskId?: string;
  projectId: string;
  projectPath: string;
  
  // Test Gate
  testCommand?: string;
  
  // Checkpoint Gate
  checkpoint?: any;
  
  // Review Gate
  prNumber?: number;
  minReviewers?: number;
  
  // Contract Gate
  oldContractPath?: string;
  newContractPath?: string;
  
  // Security Gate
  securityScanCommand?: string;
  
  // Performance Gate
  performanceThresholds?: PerformanceThresholds;
}

export interface PerformanceThresholds {
  maxResponseTime?: number;
  maxMemoryUsage?: number;
  minCoverage?: number;
  maxBundleSize?: number;
}

export interface GateConfig {
  enabled: boolean;
  required: boolean;
  autoFix: boolean;
  onFailure: 'block' | 'warn' | 'skip';
  timeout?: number;
}

export interface ProjectGateConfig {
  projectId: string;
  gates: Record<GateType, GateConfig>;
  defaults: {
    testCommand: string;
    minReviewers: number;
    securityScanCommand: string;
  };
}

export interface MeetingGateConfig {
  meetingId: string;
  constraintLevel: 'L1' | 'L2' | 'L3' | 'L4';
  overrides: Partial<Record<GateType, Partial<GateConfig>>>;
}

export interface TaskGateConfig {
  taskId: string;
  gates: GateType[];
  customConfig?: Partial<Record<GateType, Partial<GateConfig>>>;
}

export interface GateCheckReport {
  meetingId: string;
  taskId?: string;
  timestamp: string;
  overallPassed: boolean;
  results: Record<GateType, GateResult>;
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
  };
  nextActions: string[];
}

export interface GateCheckerConfig {
  contextSharer: ContextSharer;
}

// ==================== GateChecker 类 ====================

export class GateChecker {
  private contextSharer: ContextSharer;

  // Layer 1: harness 核心门禁
  private passesGate: PassesGate;
  private checkpointValidator: CheckpointValidator;
  private constraintChecker: ConstraintChecker;

  // Layer 2: harness-gates 扩展门禁
  private reviewGate: ReviewGate;
  private securityGate: SecurityGate;
  private performanceGate: PerformanceGate;
  private contractGate: ContractGate;
  private acceptanceGate: SpecAcceptanceGate;

  // Layer 3: 业务层
  private bypassManager: GateBypassManager;

  constructor(config: GateCheckerConfig) {
    this.contextSharer = config.contextSharer;

    // 初始化 Layer 1 门禁
    this.passesGate = new PassesGate();
    this.checkpointValidator = CheckpointValidator.getInstance();
    this.constraintChecker = ConstraintChecker.getInstance();

    // 初始化 Layer 2 门禁
    this.reviewGate = new ReviewGate();
    this.securityGate = new SecurityGate();
    this.performanceGate = new PerformanceGate();
    this.contractGate = new ContractGate();
    this.acceptanceGate = new SpecAcceptanceGate();

    // 初始化 Layer 3 业务层
    this.bypassManager = new GateBypassManager({
      contextSharer: config.contextSharer,
    });
  }

  // ==================== 单门禁检查 ====================

  /**
   * 检查单个门禁
   */
  async checkGate(gate: GateType, context: GateCheckContext): Promise<GateResult> {
    const startTime = Date.now();

    try {
      let result: GateResult;

      switch (gate) {
        case 'test':
          result = await this.checkTestGate(context);
          break;
        case 'spec':
          result = await this.checkSpecGate(context);
          break;
        case 'checkpoint':
          result = await this.checkCheckpointGate(context);
          break;
        case 'review':
          result = await this.checkReviewGate(context);
          break;
        case 'contract':
          result = await this.checkContractGate(context);
          break;
        case 'security':
          result = await this.checkSecurityGate(context);
          break;
        case 'performance':
          result = await this.checkPerformanceGate(context);
          break;
        case 'acceptance':
          result = await this.checkAcceptanceGate(context);
          break;
        default:
          result = {
            gate,
            passed: false,
            status: 'failed',
            message: `Unknown gate type: ${gate}`,
            timestamp: new Date().toISOString(),
          };
      }

      result.duration = Date.now() - startTime;
      return result;
    } catch (error: any) {
      return {
        gate,
        passed: false,
        status: 'failed',
        message: `Gate check error: ${error.message}`,
        timestamp: new Date().toISOString(),
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * 批量检查门禁
   */
  async checkAllGates(
    gates: GateType[],
    context: GateCheckContext
  ): Promise<GateCheckReport> {
    const results: Record<GateType, GateResult> = {} as any;
    
    for (const gate of gates) {
      results[gate] = await this.checkGate(gate, context);
    }

    const passed = Object.values(results).filter(r => r.passed).length;
    const failed = Object.values(results).filter(r => !r.passed && r.status !== 'skipped').length;
    const skipped = Object.values(results).filter(r => r.status === 'skipped').length;

    const nextActions = this.generateNextActions(results);

    return {
      meetingId: context.meetingId,
      taskId: context.taskId,
      timestamp: new Date().toISOString(),
      overallPassed: failed === 0,
      results,
      summary: {
        total: gates.length,
        passed,
        failed,
        skipped,
      },
      nextActions,
    };
  }

  // ==================== Layer 1: harness 核心门禁 ====================

  /**
   * 测试门禁 - 复用 harness PassesGate
   */
  private async checkTestGate(context: GateCheckContext): Promise<GateResult> {
    const testCommand = context.testCommand ?? 'npm test';

    // 复用 harness PassesGate
    const result = await this.passesGate.runTests();

    return {
      gate: 'test',
      passed: result.passed,
      status: result.passed ? 'passed' : 'failed',
      message: result.message ?? (result.passed ? 'Tests passed' : 'Tests failed'),
      details: {
        command: testCommand,
        passedTests: result.passedTests,
        failedTests: result.failedTests,
        totalTests: result.totalTests,
        duration: result.duration,
        failures: result.failures,
      },
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Spec 门禁 - 复用 harness SpecValidator
   */
  private async checkSpecGate(context: GateCheckContext): Promise<GateResult> {
    // 复用 harness SpecValidator
    const validator = SpecValidator.getInstance();
    
    try {
      // 使用 validateAll 验证项目中的 spec 文件
      const result = await validator.validateAll(context.projectPath);
      
      // 计算是否通过（没有错误）
      const hasErrors = result.results.some(r => r.errors && r.errors.length > 0);
      const passed = !hasErrors && result.failed === 0;
      
      return {
        gate: 'spec',
        passed,
        status: passed ? 'passed' : 'failed',
        message: passed 
          ? `Spec validation passed (${result.passed}/${result.total} files)` 
          : `Spec validation failed (${result.failed}/${result.total} files)`,
        details: {
          projectPath: context.projectPath,
          total: result.total,
          passed: result.passed,
          failed: result.failed,
          warnings: result.warnings,
          results: result.results,
        },
        timestamp: new Date().toISOString(),
      };
    } catch (error: any) {
      // Spec 验证失败可能是没有 spec 文件，不算失败
      if (error.code === 'ENOENT' || error.message?.includes('ENOENT')) {
        return {
          gate: 'spec',
          passed: true,
          status: 'passed',
          message: 'No spec files found, skipping validation',
          timestamp: new Date().toISOString(),
        };
      }
      
      return {
        gate: 'spec',
        passed: false,
        status: 'failed',
        message: `Spec validation error: ${error.message}`,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * 检查点门禁 - 复用 harness CheckpointValidator
   */
  private async checkCheckpointGate(context: GateCheckContext): Promise<GateResult> {
    if (!context.checkpoint) {
      return {
        gate: 'checkpoint',
        passed: true,
        status: 'passed',
        message: 'No checkpoint defined, skipping',
        timestamp: new Date().toISOString(),
      };
    }

    // 复用 harness CheckpointValidator
    const result = await this.checkpointValidator.validate(context.checkpoint, {
      workdir: context.projectPath,
    } as any);

    return {
      gate: 'checkpoint',
      passed: result.passed,
      status: result.passed ? 'passed' : 'failed',
      message: result.message ?? '',
      details: {
        checkpointId: result.checkpointId ?? '',
        checks: result.checks,
      },
      timestamp: new Date().toISOString(),
    };
  }

  // ==================== Layer 2: harness-gates 扩展门禁 ====================

  /**
   * 审查门禁 - 使用 harness-gates ReviewGate
   */
  private async checkReviewGate(context: GateCheckContext): Promise<GateResult> {
    const result = await this.reviewGate.check(context);

    return {
      gate: 'review',
      passed: result.passed,
      status: result.passed ? 'passed' : 'failed',
      message: result.message,
      details: result.details,
      timestamp: result.timestamp,
    };
  }

  /**
   * 契约门禁 - 使用 harness-gates ContractGate
   */
  private async checkContractGate(context: GateCheckContext): Promise<GateResult> {
    const result = await this.contractGate.check(context);

    return {
      gate: 'contract',
      passed: result.passed,
      status: result.passed ? 'passed' : 'failed',
      message: result.message,
      details: result.details,
      timestamp: result.timestamp,
    };
  }

  /**
   * 安全门禁 - 使用 harness-gates SecurityGate
   */
  private async checkSecurityGate(context: GateCheckContext): Promise<GateResult> {
    const result = await this.securityGate.scan(context);

    return {
      gate: 'security',
      passed: result.passed,
      status: result.passed ? 'passed' : 'failed',
      message: result.message,
      details: result.details,
      timestamp: result.timestamp,
    };
  }

  /**
   * 性能门禁 - 使用 harness-gates PerformanceGate
   */
  private async checkPerformanceGate(context: GateCheckContext): Promise<GateResult> {
    const result = await this.performanceGate.check(context);

    return {
      gate: 'performance',
      passed: result.passed,
      status: result.passed ? 'passed' : 'failed',
      message: result.message,
      details: result.details,
      timestamp: result.timestamp,
    };
  }

  /**
   * 验收标准门禁 - 使用 harness SpecAcceptanceGate
   */
  private async checkAcceptanceGate(context: GateCheckContext): Promise<GateResult> {
    const result = await this.acceptanceGate.check({
      projectPath: context.projectPath,
      taskId: context.taskId,
    });

    return {
      gate: 'acceptance',
      passed: result.passed,
      status: result.passed ? 'passed' : 'failed',
      message: result.message,
      details: result.details,
      timestamp: result.timestamp,
    };
  }

  // ==================== 门禁绕过管理 ====================

  /**
   * 检查是否可以绕过门禁
   */
  async checkBypass(
    meetingId: string,
    gate: GateType,
    taskId?: string
  ): Promise<BypassCheckResult> {
    return this.bypassManager.checkBypass(meetingId, gate, taskId);
  }

  /**
   * 请求门禁绕过
   */
  async requestBypass(request: {
    meetingId: string;
    taskId?: string;
    gates: GateType[];
    reason: 'emergency_fix' | 'hotfix' | 'security_patch' | 'test_infrastructure_issue' | 'dependency_issue' | 'manual_override' | 'other';
    requestedBy: string;
    urgency?: 'low' | 'medium' | 'high' | 'critical';
  }): Promise<{ id: string; status: string }> {
    const record = await this.bypassManager.requestBypass(request);
    return {
      id: record.id,
      status: record.status,
    };
  }

  /**
   * 批准门禁绕过
   */
  async approveBypass(bypassId: string, approvedBy: string): Promise<void> {
    await this.bypassManager.approveBypass(bypassId, approvedBy);
  }

  // ==================== 配置管理 ====================

  /**
   * 获取有效门禁配置（合并三层）
   */
  async getEffectiveConfig(
    projectId: string,
    meetingId: string,
    taskId?: string
  ): Promise<Record<GateType, GateConfig>> {
    const projectConfig = await this.getProjectGateConfig(projectId);
    const meetingConfig = await this.getMeetingGateConfig(meetingId);
    
    let taskConfig: Partial<Record<GateType, Partial<GateConfig>>> = {};
    if (taskId) {
      taskConfig = (await this.getTaskGateConfig(taskId))?.customConfig ?? {};
    }

    const effectiveConfig: Record<GateType, GateConfig> = { ...projectConfig.gates };

    for (const [gate, override] of Object.entries(meetingConfig.overrides)) {
      effectiveConfig[gate as GateType] = {
        ...effectiveConfig[gate as GateType],
        ...override,
      };
    }

    for (const [gate, custom] of Object.entries(taskConfig)) {
      effectiveConfig[gate as GateType] = {
        ...effectiveConfig[gate as GateType],
        ...custom,
      };
    }

    return effectiveConfig;
  }

  /**
   * 保存门禁检查结果
   */
  async saveGateResult(meetingId: string, report: GateCheckReport): Promise<void> {
    const results = await this.getGateResults(meetingId);
    results.push(report);
    
    const trimmed = results.slice(-100);
    await this.contextSharer.set(`meeting:${meetingId}:gate-results`, trimmed);
  }

  // ==================== 私有方法 ====================

  private generateNextActions(results: Record<GateType, GateResult>): string[] {
    const actions: string[] = [];
    
    for (const [gate, result] of Object.entries(results)) {
      if (!result.passed) {
        switch (gate as GateType) {
          case 'test':
            actions.push('运行测试并修复失败的用例');
            break;
          case 'review':
            actions.push('请求代码审查并等待审批');
            break;
          case 'contract':
            actions.push('检查 API 变更，确保向后兼容');
            break;
          case 'spec':
            actions.push('对照 Spec 修正实现');
            break;
          case 'security':
            actions.push('修复安全漏洞');
            break;
          case 'performance':
            actions.push('优化性能指标');
            break;
          case 'checkpoint':
            actions.push('完成检查点要求');
            break;
          case 'acceptance':
            actions.push('完成验收标准要求');
            break;
        }
      }
    }

    return actions;
  }

  private async getProjectGateConfig(projectId: string): Promise<ProjectGateConfig> {
    const data = await this.contextSharer.getValue<ProjectGateConfig>(`project:${projectId}:gate-config`);
    
    if (data) return data;

    return {
      projectId,
      gates: {
        test: { enabled: true, required: true, autoFix: true, onFailure: 'block' },
        spec: { enabled: true, required: false, autoFix: false, onFailure: 'warn' },
        checkpoint: { enabled: true, required: true, autoFix: false, onFailure: 'block' },
        review: { enabled: true, required: true, autoFix: false, onFailure: 'block' },
        contract: { enabled: true, required: false, autoFix: false, onFailure: 'warn' },
        security: { enabled: true, required: true, autoFix: false, onFailure: 'block' },
        performance: { enabled: false, required: false, autoFix: false, onFailure: 'warn' },
        acceptance: { enabled: true, required: false, autoFix: false, onFailure: 'warn' },
      },
      defaults: {
        testCommand: 'npm test',
        minReviewers: 1,
        securityScanCommand: 'npm audit',
      },
    };
  }

  private async getMeetingGateConfig(meetingId: string): Promise<MeetingGateConfig> {
    const data = await this.contextSharer.getValue<MeetingGateConfig>(`meeting:${meetingId}:gate-config`);
    return data ?? { meetingId, constraintLevel: 'L2', overrides: {} };
  }

  private async getTaskGateConfig(taskId: string): Promise<TaskGateConfig | null> {
    return this.contextSharer.getValue<TaskGateConfig>(`task:${taskId}:gate-config`);
  }

  private async getGateResults(meetingId: string): Promise<GateCheckReport[]> {
    const data = await this.contextSharer.getValue<GateCheckReport[]>(`meeting:${meetingId}:gate-results`);
    return data ?? [];
  }
}

// ==================== 工厂函数 ====================

export function createGateChecker(config: GateCheckerConfig): GateChecker {
  return new GateChecker(config);
}
