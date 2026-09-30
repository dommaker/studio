// Harness API — /harness/*（T-015 Harness 监控集成，admin 中间件）
// 注：/harness/deploy/approve|reject 后端无对应路由，其唯一消费方 DeployApprovalCard 已删除（2026-08-06：无生产端建卡消息、无存量数据，整条死链）
// 契约驱动迁移（2026-10 批次 6/7）：响应类型改 contract import（原手抄
// ConstraintCheckResult 删除）；check-constraints 兄弟标注键
// （strippedEvidenceFlags/violationPartialView）随迁移收进 data 内。
import { api } from './index';
import type { CheckConstraintsResult } from '@dommaker/studio-contract';

/** POST /harness/check-constraints 的约束检查结果（M2 质量门；别名保持旧名） */
export type ConstraintCheckResult = CheckConstraintsResult;

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
