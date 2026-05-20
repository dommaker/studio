/**
 * Auditor ↔ 其他角色协议定义（BP-013 + BP-014）
 *
 * Auditor 产出结论，Knowledge Keeper 和 ConstraintEvolver 消费。
 */

// ═══════════════════════════════════════════════════════════
// BP-013: Auditor ↔ Knowledge Keeper 协议
// ═══════════════════════════════════════════════════════════

/** 结论置信度等级 */
export type ConclusionLevel = 'verified' | 'observed' | 'anomaly';

/** Auditor 产出的单条结论 */
export interface AuditorConclusion {
  id: string;
  level: ConclusionLevel;
  category: 'skill' | 'constraint' | 'process' | 'decision_quality' | 'stance';
  summary: string;
  evidence: {
    observation: string;       // 观察到的现象
    baseline: string;          // 基线数据（变更前）
    current: string;           // 当前数据（变更后）
    sampleSize: number;        // 样本量
    confidence: number;        // Auditor 自身置信度 0-1
  };
  alternativeExplanations: string[];  // skeptic 立场产出的替代解释
  recommendation: {
    action: 'apply' | 'suggest' | 'monitor';
    target: 'system_prompt' | 'bound_skills' | 'bound_constraints' | 'execution_params' | 'stance_prompt' | 'planner_config';
    targetRole?: string;       // 目标角色（analyst/executor/reviewer/knowledge_keeper/auditor）
    targetId?: string;         // 目标实体 ID（skillId/constraintId/stanceId）
    description: string;
  };
  createdAt: string;
  reportSource: string;        // daily-{date}.md 或 weekly-{date}.md
}

/** Knowledge Keeper 消费 Auditor 结论的决策规则 */
export interface KKConsumptionRule {
  level: ConclusionLevel;
  minConfidence: number;
  autoApply: boolean;
  requiresApproval: boolean;
  description: string;
}

/** 默认消费规则 */
export const DEFAULT_CONSUMPTION_RULES: KKConsumptionRule[] = [
  {
    level: 'verified',
    minConfidence: 0.8,
    autoApply: true,
    requiresApproval: false,
    description: '因果证据充分 + Auditor 自身高置信 → 自动执行',
  },
  {
    level: 'verified',
    minConfidence: 0.5,
    autoApply: false,
    requiresApproval: true,
    description: '因果证据充分但 Auditor 自身低置信 → 待人工审批',
  },
  {
    level: 'observed',
    minConfidence: 0.6,
    autoApply: false,
    requiresApproval: true,
    description: '相关但未证明因果 → Knowledge Keeper 二次验证后可执行',
  },
  {
    level: 'observed',
    minConfidence: 0,
    autoApply: false,
    requiresApproval: false,
    description: '低置信度观测 → 仅记录，等待更多数据',
  },
  {
    level: 'anomaly',
    minConfidence: 0,
    autoApply: false,
    requiresApproval: false,
    description: '异常信号 → 通知 Monitor，不自动操作',
  },
];

// ═══════════════════════════════════════════════════════════
// BP-014: Auditor ↔ ConstraintEvolver 协议
// ═══════════════════════════════════════════════════════════

/** 约束变更的效果评估 */
export interface ConstraintEffectReport {
  constraintId: string;
  changeType: 'level_change' | 'add_exception' | 'adjust_trigger' | 'modify_message' | 'new_constraint';
  changedAt: string;
  evaluationWindow: {
    start: string;
    end: string;
    totalExecutions: number;
  };
  metrics: {
    metric: string;            // 指标名
    before: string;            // 变更前
    after: string;             // 变更后
    change: string;            // 变化幅度
    direction: 'improved' | 'degraded' | 'unchanged';
  }[];
  verdict: 'keep' | 'rollback' | 'adjust' | 'insufficient_data';
  verdictReason: string;
}

/** ConstraintEvolver 如何处理效果评估 */
export interface ConstraintEffectAction {
  constraintId: string;
  action: 'keep' | 'rollback' | 'adjust';
  reason: string;
  autoExecute: boolean;
}

/**
 * 决策函数：根据效果报告决定是否自动回滚/调整
 */
export function decideConstraintAction(report: ConstraintEffectReport): ConstraintEffectAction {
  // 数据不足 → 保持，延长评估窗口
  if (report.verdict === 'insufficient_data') {
    return {
      constraintId: report.constraintId,
      action: 'keep',
      reason: `样本不足（${report.evaluationWindow.totalExecutions} 次执行），延长评估窗口`,
      autoExecute: true,
    };
  }

  // 明确退化 → 自动回滚（低风险）
  if (report.verdict === 'rollback' && report.changeType !== 'new_constraint') {
    return {
      constraintId: report.constraintId,
      action: 'rollback',
      reason: report.verdictReason,
      autoExecute: true,
    };
  }

  // 新增约束失败 → 需审批再回滚（新增约束的回滚需要人工确认）
  if (report.verdict === 'rollback' && report.changeType === 'new_constraint') {
    return {
      constraintId: report.constraintId,
      action: 'rollback',
      reason: report.verdictReason + '（新增约束回滚需人工确认）',
      autoExecute: false,
    };
  }

  // 部分退化 → 建议调整，需审批
  if (report.verdict === 'adjust') {
    return {
      constraintId: report.constraintId,
      action: 'adjust',
      reason: report.verdictReason,
      autoExecute: false,
    };
  }

  // 改善 → 保留
  return {
    constraintId: report.constraintId,
    action: 'keep',
    reason: `效果正面：${report.metrics.map(m => `${m.metric} ${m.direction}`).join('，')}`,
    autoExecute: true,
  };
}
