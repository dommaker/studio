// Harness API — /harness/*（T-015 Harness 监控集成，admin 中间件）
// 注：/harness/deploy/approve|reject 后端无对应路由（DeployApprovalCard 审批链为死链），未收编
import { api } from './index';

/** POST /harness/check-constraints 的约束检查结果（M2 质量门；只声明 RequirementsDocCard 消费字段） */
export interface ConstraintCheckResult {
  passed?: boolean;
  ironLaws?: Array<{ satisfied: boolean }>;
  guidelines?: unknown[];
  warningCount?: number;
}

export const harnessApi = {
  /** M2 质量门：非抛出式约束检查（RequirementsDoc 执行前确认） */
  checkConstraints: (data: {
    operation: string;
    taskDescription?: string;
    projectPath?: string;
    hasRequirement?: boolean;
    hasRequirementReview?: boolean;
  }) => api.post<{ data: ConstraintCheckResult }>('/harness/check-constraints', data),
};
