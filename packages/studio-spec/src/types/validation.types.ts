/**
 * Spec 验证类型定义
 */

// 验证层级
export type ValidationLayer = 'architecture' | 'api' | 'acceptance';

// Spec 内容类型（解析后）
export interface SpecContent {
  metadata: {
    id: string;
    title?: string;
    status?: 'draft' | 'in_progress' | 'completed' | 'deprecated';
    created?: string;
    updated?: string;
  };
  architecture?: {
    dependencies?: string[];
    data_models?: string[];
  };
  api?: {
    endpoints?: ApiEndpoint[];
    schemas?: Record<string, SchemaDefinition>;
  };
  acceptance_criteria?: AcceptanceCriterion[];
}

// API Endpoint 定义
export interface ApiEndpoint {
  path: string;
  method: string;
  request?: string;
  response?: string;
}

// Schema 定义
export interface SchemaDefinition {
  type: string;
  properties?: Record<string, unknown>;
}

// Acceptance Criterion
export interface AcceptanceCriterion {
  id: string;
  description: string;
  test?: string;
  passes?: boolean;
}

// === 验证输入/输出 ===

// 综合验证输入
export interface ValidateSpecInput {
  specId: string;
  specPath?: string;
  specContent?: SpecContent; // 直接传入 Spec 内容（用于测试）
  layers?: ValidationLayer[];
}

// 综合验证结果
export interface ValidationResult {
  specId: string;
  valid: boolean;
  layers: {
    architecture?: LayerResult;
    api?: LayerResult;
    acceptance?: LayerResult;
  };
  errors: ValidationError[];
  warnings: ValidationWarning[];
  summary: string;
}

// 单层验证结果
export interface LayerResult {
  valid: boolean;
  checks: CheckResult[];
}

// 单项检查结果
export interface CheckResult {
  checkId: string;
  description: string;
  passed: boolean;
  message?: string;
  location?: string;
}

// 验证错误
export interface ValidationError {
  layer: ValidationLayer;
  checkId: string;
  message: string;
  location?: string;
  severity: 'error' | 'warning';
}

// 验证警告
export interface ValidationWarning {
  layer: ValidationLayer;
  checkId: string;
  message: string;
  location?: string;
}

// === 架构验证 ===

export interface ArchitectureValidationInput {
  spec: SpecContent;
}

export interface ArchitectureValidationResult {
  valid: boolean;
  checks: CheckResult[];
  missingFields: string[];
  invalidReferences: string[];
}

// === API 验证 ===

export interface ApiValidationInput {
  spec: SpecContent;
}

export interface ApiValidationResult {
  valid: boolean;
  checks: CheckResult[];
  invalidEndpoints: string[];
  missingSchemas: string[];
}

// === 验收验证 ===

export interface AcceptanceValidationInput {
  spec: SpecContent;
  testDir?: string;
}

export interface AcceptanceValidationResult {
  valid: boolean;
  checks: CheckResult[];
  untestableCriteria: string[];
  duplicateIds: string[];
}