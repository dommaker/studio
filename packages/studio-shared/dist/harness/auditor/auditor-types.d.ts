/**
 * Auditor ↔ 其他角色协议定义（BP-013 + BP-014）
 *
 * Auditor 产出结论，Knowledge Keeper 和 ConstraintEvolver 消费。
 */
/** 结论置信度等级 */
export type ConclusionLevel = 'verified' | 'observed' | 'anomaly';
/** Auditor 产出的单条结论 */
export interface AuditorConclusion {
    id: string;
    level: ConclusionLevel;
    category: 'skill' | 'constraint' | 'process' | 'decision_quality' | 'stance';
    summary: string;
    evidence: {
        observation: string;
        baseline: string;
        current: string;
        sampleSize: number;
        confidence: number;
    };
    alternativeExplanations: string[];
    recommendation: {
        action: 'apply' | 'suggest' | 'monitor';
        target: 'system_prompt' | 'bound_skills' | 'bound_constraints' | 'execution_params' | 'stance_prompt' | 'planner_config';
        targetRole?: string;
        targetId?: string;
        description: string;
    };
    createdAt: string;
    reportSource: string;
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
export declare const DEFAULT_CONSUMPTION_RULES: KKConsumptionRule[];
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
        metric: string;
        before: string;
        after: string;
        change: string;
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
export declare function decideConstraintAction(report: ConstraintEffectReport): ConstraintEffectAction;
//# sourceMappingURL=auditor-types.d.ts.map