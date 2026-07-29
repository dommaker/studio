/**
 * Auditor ↔ 其他角色协议定义（BP-013 + BP-014）
 *
 * Auditor 产出结论，Knowledge Keeper 和 ConstraintEvolver 消费。
 */
/** 默认消费规则 */
export const DEFAULT_CONSUMPTION_RULES = [
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
/**
 * 决策函数：根据效果报告决定是否自动回滚/调整
 */
export function decideConstraintAction(report) {
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
//# sourceMappingURL=auditor-types.js.map