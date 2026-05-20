/**
 * Spec 约束层管理
 * 
 * 功能：
 * 1. SpecValidator 集成（格式验证 + 业务验证）
 * 2. Spec 变更分级处理
 * 3. Spec 门禁配置
 * 
 * 验证流程：
 * 1. harness SpecValidator → 格式验证（YAML 语法、Schema 合规）
 * 2. SpecConstraintLayer → 业务验证（架构合理性、模块职责、API 完整性）
 */

import type { ContextSharer } from './context-sharer';
import { SpecValidator as HarnessSpecValidator } from '@dommaker/harness';

// ==================== 类型定义 ====================

/**
 * 变更级别
 */
export type ChangeLevel = 'L1' | 'L2' | 'L3' | 'L4';

/**
 * 变更类型
 */
export type ChangeType = 'architecture' | 'api' | 'module' | 'config' | 'ui' | 'other';

/**
 * Spec 定义
 */
export interface SpecDefinition {
  id: string;
  projectId: string;
  version: string;
  
  // 内容
  architecture?: ArchitectureSpec;
  modules?: ModuleSpec[];
  apis?: APISpec[];
  constraints?: ConstraintSpec[];
  
  // 元数据
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  approvedBy?: string;
}

/**
 * 架构 Spec
 */
export interface ArchitectureSpec {
  description: string;
  layers: string[];
  dataFlow?: string;
  dependencies?: string[];
}

/**
 * 模块 Spec
 */
export interface ModuleSpec {
  name: string;
  description: string;
  responsibilities: string[];
  interfaces: string[];
  dependencies?: string[];
}

/**
 * API Spec
 */
export interface APISpec {
  path: string;
  method: string;
  description: string;
  request?: any;
  response?: any;
  breaking?: boolean;
}

/**
 * 约束 Spec
 */
export interface ConstraintSpec {
  key: string;
  type: 'performance' | 'security' | 'compatibility' | 'business';
  description: string;
  value: any;
  enforced: boolean;
}

/**
 * Spec 变更请求
 */
export interface SpecChangeRequest {
  id: string;
  projectId: string;
  level: ChangeLevel;
  type: ChangeType;
  
  // 变更内容
  description: string;
  affectedModules: string[];
  breaking: boolean;
  
  // 审批
  status: 'pending' | 'approved' | 'rejected' | 'executed';
  requestedBy: string;
  requestedAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewNotes?: string;
  
  // 执行结果
  executedAt?: string;
  executionResult?: string;
}

/**
 * Spec 门禁配置
 */
export interface SpecGateConfig {
  projectId: string;
  
  // 门禁级别设置
  gateLevels: {
    L1: GateLevelConfig;  // 小改动
    L2: GateLevelConfig;  // 中改动
    L3: GateLevelConfig;  // 大改动
    L4: GateLevelConfig;  // 紧急改动
  };
  
  // 审批人配置
  approvers: {
    L2: string[];  // 单签审批人
    L3: string[];  // 双签审批人（需要 2 人）
    L4: string[];  // 紧急审批人
  };
}

/**
 * 门禁级别配置
 */
export interface GateLevelConfig {
  autoApprove: boolean;
  requireApproval: boolean;
  requireMeeting: boolean;
  allowBypass: boolean;
  bypassDeadline?: number;  // 小时
}

/**
 * Spec 验证结果
 */
export interface SpecValidationResult {
  valid: boolean;
  errors: SpecValidationError[];
  warnings: SpecValidationWarning[];
}

/**
 * Spec 验证错误
 */
export interface SpecValidationError {
  code: string;
  message: string;
  location: string;
  suggestion?: string;
}

/**
 * Spec 验证警告
 */
export interface SpecValidationWarning {
  code: string;
  message: string;
  location: string;
}

/**
 * Spec 约束层配置
 */
export interface SpecConstraintLayerConfig {
  contextSharer: ContextSharer;
}

// ==================== SpecConstraintLayer 类 ====================

export class SpecConstraintLayer {
  private contextSharer: ContextSharer;
  private harnessSpecValidator: ReturnType<typeof HarnessSpecValidator.getInstance>;

  constructor(config: SpecConstraintLayerConfig) {
    this.contextSharer = config.contextSharer;
    this.harnessSpecValidator = HarnessSpecValidator.getInstance();
  }

  // ==================== Spec 管理 ====================

  /**
   * 创建 Spec
   */
  async createSpec(projectId: string, spec: Omit<SpecDefinition, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>): Promise<SpecDefinition> {
    const now = new Date().toISOString();
    
    const newSpec: SpecDefinition = {
      ...spec,
      id: `spec-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      projectId,
      createdAt: now,
      updatedAt: now,
    };

    await this.saveSpec(projectId, newSpec);
    return newSpec;
  }

  /**
   * 获取 Spec
   */
  async getSpec(projectId: string): Promise<SpecDefinition | null> {
    return this.contextSharer.getValue<SpecDefinition>(`project:${projectId}:spec`);
  }

  /**
   * 更新 Spec
   */
  async updateSpec(projectId: string, updates: Partial<SpecDefinition>): Promise<SpecDefinition | null> {
    const spec = await this.getSpec(projectId);
    
    if (!spec) {
      return null;
    }

    const updated: SpecDefinition = {
      ...spec,
      ...updates,
      id: spec.id,
      projectId: spec.projectId,
      createdAt: spec.createdAt,
      updatedAt: new Date().toISOString(),
    };

    await this.saveSpec(projectId, updated);
    return updated;
  }

  // ==================== Spec 验证 ====================

  /**
   * 验证 Spec 文件格式（组合 harness SpecValidator）
   * 
   * 验证流程：
   * 1. harness SpecValidator → 格式验证（YAML 语法、Schema 合规）
   * 2. SpecConstraintLayer → 业务验证（架构合理性、模块职责）
   * 
   * @param specFile Spec 文件路径
   * @param spec 解析后的 Spec 对象（可选，不传则只做格式验证）
   */
  async validateSpecFile(
    specFile: string,
    spec?: SpecDefinition
  ): Promise<SpecValidationResult> {
    const errors: SpecValidationError[] = [];
    const warnings: SpecValidationWarning[] = [];

    // Step 1: 格式验证（harness SpecValidator）
    const formatResult = await this.harnessSpecValidator.validateFile(specFile);
    
    if (!formatResult.valid) {
      // 格式验证失败，直接返回
      return {
        valid: false,
        errors: formatResult.errors.map(e => ({
          code: 'FORMAT_ERROR',
          message: e.message,
          location: e.path || specFile,
        })),
        warnings: formatResult.warnings.map(w => ({
          code: 'FORMAT_WARNING',
          message: w.message,
          location: w.path || specFile,
        })),
      };
    }

    // Step 2: 业务验证（如果有 Spec 对象）
    if (spec) {
      const businessResult = await this.validateSpec(spec);
      errors.push(...businessResult.errors);
      warnings.push(...businessResult.warnings);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * 验证 Spec 完整性（业务验证）
   */
  async validateSpec(spec: SpecDefinition): Promise<SpecValidationResult> {
    const errors: SpecValidationError[] = [];
    const warnings: SpecValidationWarning[] = [];

    // 验证架构
    if (spec.architecture) {
      const archErrors = this.validateArchitecture(spec.architecture);
      errors.push(...archErrors);
    }

    // 验证模块
    if (spec.modules) {
      for (const module of spec.modules) {
        const moduleErrors = this.validateModule(module);
        errors.push(...moduleErrors);
      }
    }

    // 验证 API
    if (spec.apis) {
      for (const api of spec.apis) {
        const apiWarnings = this.validateAPI(api);
        warnings.push(...apiWarnings);
      }
    }

    // 验证约束
    if (spec.constraints) {
      for (const constraint of spec.constraints) {
        const constraintErrors = this.validateConstraint(constraint);
        errors.push(...constraintErrors);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * 验证代码是否符合 Spec
   */
  async validateAgainstSpec(projectId: string, codeChanges: {
    files: string[];
    modules: string[];
    apis: string[];
  }): Promise<SpecValidationResult> {
    const spec = await this.getSpec(projectId);
    
    if (!spec) {
      return {
        valid: true,
        errors: [],
        warnings: [{
          code: 'SPEC_NOT_FOUND',
          message: '项目没有 Spec 定义，跳过验证',
          location: projectId,
        }],
      };
    }

    const errors: SpecValidationError[] = [];
    const warnings: SpecValidationWarning[] = [];

    // 检查模块边界
    if (spec.modules) {
      for (const changedModule of codeChanges.modules) {
        const moduleSpec = spec.modules.find(m => m.name === changedModule);
        
        if (!moduleSpec) {
          warnings.push({
            code: 'MODULE_NOT_IN_SPEC',
            message: `模块 ${changedModule} 不在 Spec 中定义`,
            location: changedModule,
          });
        }
      }
    }

    // 检查 API 兼容性
    if (spec.apis) {
      for (const changedAPI of codeChanges.apis) {
        const apiSpec = spec.apis.find(a => a.path === changedAPI);
        
        if (apiSpec?.breaking) {
          errors.push({
            code: 'BREAKING_API_CHANGE',
            message: `API ${changedAPI} 被标记为破坏性变更`,
            location: changedAPI,
            suggestion: '需要提交变更请求并审批',
          });
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  // ==================== 变更分级 ====================

  /**
   * 分析变更级别
   */
  analyzeChangeLevel(change: {
    type: ChangeType;
    description: string;
    affectedModules: string[];
    breaking: boolean;
  }): ChangeLevel {
    // 规则 1：影响范围
    if (change.affectedModules.length > 3) {
      return 'L3';  // 影响超过 3 个模块 = 大改动
    }

    // 规则 2：变更类型
    if (change.type === 'architecture') {
      return 'L3';  // 架构变更 = 大改动
    }

    if (change.type === 'api') {
      if (change.breaking) {
        return 'L3';  // 破坏性 API 变更 = 大改动
      }
      return 'L2';  // 非破坏性 API 变更 = 中改动
    }

    // 规则 3：关键字匹配
    const l3Keywords = ['架构', '模块', '拆分', '重构', '迁移', '核心', '底层'];
    const l2Keywords = ['接口', '字段', '约束', '边界', '流程'];
    
    if (l3Keywords.some(kw => change.description.includes(kw))) {
      return 'L3';
    }
    if (l2Keywords.some(kw => change.description.includes(kw))) {
      return 'L2';
    }

    return 'L1';  // 默认小改动
  }

  /**
   * 创建变更请求
   */
  async createChangeRequest(projectId: string, change: {
    type: ChangeType;
    description: string;
    affectedModules: string[];
    breaking: boolean;
    requestedBy: string;
  }): Promise<SpecChangeRequest> {
    const level = this.analyzeChangeLevel(change);
    
    const request: SpecChangeRequest = {
      id: `change-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      projectId,
      level,
      type: change.type,
      description: change.description,
      affectedModules: change.affectedModules,
      breaking: change.breaking,
      status: 'pending',
      requestedBy: change.requestedBy,
      requestedAt: new Date().toISOString(),
    };

    // 自动处理 L1
    if (level === 'L1') {
      request.status = 'approved';
      request.reviewedBy = 'system';
      request.reviewedAt = new Date().toISOString();
      request.reviewNotes = 'L1 变更自动批准';
    }

    await this.saveChangeRequest(projectId, request);
    return request;
  }

  /**
   * 审批变更请求
   */
  async approveChangeRequest(
    projectId: string,
    requestId: string,
    reviewerId: string,
    notes?: string
  ): Promise<SpecChangeRequest | null> {
    const request = await this.getChangeRequest(projectId, requestId);
    
    if (!request) {
      return null;
    }

    const gateConfig = await this.getGateConfig(projectId);
    const levelConfig = gateConfig?.gateLevels[request.level];

    // L3 需要双签
    if (request.level === 'L3') {
      const existingApproval = request.reviewedBy ? request.reviewedBy.split(',') : [];
      existingApproval.push(reviewerId);
      
      if (existingApproval.length < 2) {
        // 还需要另一个审批
        request.reviewedBy = existingApproval.join(',');
        request.reviewNotes = notes;
        await this.saveChangeRequest(projectId, request);
        return request;
      }
      
      request.reviewedBy = existingApproval.join(',');
    } else {
      request.reviewedBy = reviewerId;
    }

    request.status = 'approved';
    request.reviewedAt = new Date().toISOString();
    request.reviewNotes = notes;

    await this.saveChangeRequest(projectId, request);
    return request;
  }

  /**
   * 拒绝变更请求
   */
  async rejectChangeRequest(
    projectId: string,
    requestId: string,
    reviewerId: string,
    reason: string
  ): Promise<SpecChangeRequest | null> {
    const request = await this.getChangeRequest(projectId, requestId);
    
    if (!request) {
      return null;
    }

    request.status = 'rejected';
    request.reviewedBy = reviewerId;
    request.reviewedAt = new Date().toISOString();
    request.reviewNotes = reason;

    await this.saveChangeRequest(projectId, request);
    return request;
  }

  /**
   * 执行变更
   */
  async executeChange(projectId: string, requestId: string): Promise<SpecChangeRequest | null> {
    const request = await this.getChangeRequest(projectId, requestId);
    
    if (!request || request.status !== 'approved') {
      return null;
    }

    request.status = 'executed';
    request.executedAt = new Date().toISOString();
    request.executionResult = '变更已执行';

    await this.saveChangeRequest(projectId, request);
    return request;
  }

  // ==================== 门禁配置 ====================

  /**
   * 获取门禁配置
   */
  async getGateConfig(projectId: string): Promise<SpecGateConfig | null> {
    return this.contextSharer.getValue<SpecGateConfig>(`project:${projectId}:spec-gates`);
  }

  /**
   * 设置门禁配置
   */
  async setGateConfig(config: SpecGateConfig): Promise<void> {
    await this.contextSharer.set(`project:${config.projectId}:spec-gates`, config);
  }

  /**
   * 检查是否可以通过门禁
   */
  async checkGate(projectId: string, change: {
    type: ChangeType;
    description: string;
    affectedModules: string[];
    breaking: boolean;
  }): Promise<{
    passed: boolean;
    level: ChangeLevel;
    reason: string;
    requiredActions: string[];
  }> {
    const level = this.analyzeChangeLevel(change);
    const gateConfig = await this.getGateConfig(projectId);
    
    if (!gateConfig) {
      return {
        passed: true,
        level,
        reason: '项目未配置 Spec 门禁',
        requiredActions: [],
      };
    }

    const levelConfig = gateConfig.gateLevels[level];
    const requiredActions: string[] = [];

    // L1：自动通过
    if (level === 'L1' && levelConfig.autoApprove) {
      return {
        passed: true,
        level,
        reason: 'L1 变更自动批准',
        requiredActions: [],
      };
    }

    // L2：需要单签
    if (level === 'L2' && levelConfig.requireApproval) {
      requiredActions.push(`需要审批人批准: ${gateConfig.approvers.L2.join(' 或 ')}`);
    }

    // L3：需要双签 + 可能需要开会
    if (level === 'L3') {
      if (levelConfig.requireApproval) {
        requiredActions.push(`需要双签批准: ${gateConfig.approvers.L3.join(', ')} 中的 2 人`);
      }
      if (levelConfig.requireMeeting) {
        requiredActions.push('需要召开设计评审会议');
      }
    }

    // L4：紧急流程
    if (level === 'L4') {
      if (levelConfig.allowBypass) {
        requiredActions.push('可立即执行，但需在 24 小时内补审批');
        return {
          passed: true,
          level,
          reason: 'L4 紧急变更允许绕过门禁',
          requiredActions,
        };
      }
      requiredActions.push('紧急变更需要立即审批');
    }

    return {
      passed: requiredActions.length === 0,
      level,
      reason: requiredActions.length === 0 ? '门禁检查通过' : '需要完成以下操作',
      requiredActions,
    };
  }

  // ==================== 私有方法 ====================

  private async saveSpec(projectId: string, spec: SpecDefinition): Promise<void> {
    await this.contextSharer.set(`project:${projectId}:spec`, spec);
  }

  private async getChangeRequest(projectId: string, requestId: string): Promise<SpecChangeRequest | null> {
    const requests = await this.getChangeRequests(projectId);
    return requests.find(r => r.id === requestId) ?? null;
  }

  private async saveChangeRequest(projectId: string, request: SpecChangeRequest): Promise<void> {
    const requests = await this.getChangeRequests(projectId);
    const index = requests.findIndex(r => r.id === request.id);
    
    if (index === -1) {
      requests.push(request);
    } else {
      requests[index] = request;
    }
    
    await this.contextSharer.set(`project:${projectId}:spec-changes`, requests);
  }

  private async getChangeRequests(projectId: string): Promise<SpecChangeRequest[]> {
    const data = await this.contextSharer.getValue<SpecChangeRequest[]>(`project:${projectId}:spec-changes`);
    return data ?? [];
  }

  private validateArchitecture(arch: ArchitectureSpec): SpecValidationError[] {
    const errors: SpecValidationError[] = [];
    
    if (!arch.description) {
      errors.push({
        code: 'ARCH_NO_DESCRIPTION',
        message: '架构描述不能为空',
        location: 'architecture.description',
      });
    }
    
    if (!arch.layers || arch.layers.length === 0) {
      errors.push({
        code: 'ARCH_NO_LAYERS',
        message: '架构需要定义至少一个层级',
        location: 'architecture.layers',
      });
    }
    
    return errors;
  }

  private validateModule(module: ModuleSpec): SpecValidationError[] {
    const errors: SpecValidationError[] = [];
    
    if (!module.name) {
      errors.push({
        code: 'MODULE_NO_NAME',
        message: '模块名称不能为空',
        location: 'modules',
      });
    }
    
    if (!module.responsibilities || module.responsibilities.length === 0) {
      errors.push({
        code: 'MODULE_NO_RESPONSIBILITIES',
        message: `模块 ${module.name} 需要定义职责`,
        location: `modules.${module.name}.responsibilities`,
      });
    }
    
    return errors;
  }

  private validateAPI(api: APISpec): SpecValidationWarning[] {
    const warnings: SpecValidationWarning[] = [];
    
    if (!api.description) {
      warnings.push({
        code: 'API_NO_DESCRIPTION',
        message: `API ${api.method} ${api.path} 缺少描述`,
        location: `apis.${api.path}`,
      });
    }
    
    return warnings;
  }

  private validateConstraint(constraint: ConstraintSpec): SpecValidationError[] {
    const errors: SpecValidationError[] = [];
    
    if (!constraint.key) {
      errors.push({
        code: 'CONSTRAINT_NO_KEY',
        message: '约束键不能为空',
        location: 'constraints',
      });
    }
    
    if (constraint.value === undefined) {
      errors.push({
        code: 'CONSTRAINT_NO_VALUE',
        message: `约束 ${constraint.key} 需要定义值`,
        location: `constraints.${constraint.key}`,
      });
    }
    
    return errors;
  }
}

// ==================== 工厂函数 ====================

export function createSpecConstraintLayer(config: SpecConstraintLayerConfig): SpecConstraintLayer {
  return new SpecConstraintLayer(config);
}
