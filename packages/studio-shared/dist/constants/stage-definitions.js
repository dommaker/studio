/**
 * Stage Definitions - 阶段定义 + 关键词 + 推荐函数
 *
 * @see docs/responsibility-chain-design.md
 */
/**
 * 各阶段定义（单一数据源）
 */
export const STAGE_DEFINITIONS = {
    plan: {
        definition: '规划阶段 - 需求分析、架构设计、任务拆分',
        keywords: [
            '需求', '规划', '设计', '分析', '架构',
            '任务', 'backlog', '分解', '方案', '讨论',
            'plan', 'design', 'analysis', 'requirement', 'architecture',
        ],
        keyQuestions: [
            '是否需要分析需求？',
            '是否需要设计方案？',
            '是否需要生成任务清单？',
            '是否需要评估工作量？',
        ],
        description: '规划阶段是开发流程的起点，包括需求分析、架构设计、任务分解等活动。',
    },
    develop: {
        definition: '开发阶段 - 代码实现、功能开发',
        keywords: [
            '实现', '开发', '编写', '代码', '功能',
            '重构', 'iterate', '开发功能', '写代码',
            'develop', 'implement', 'code', 'feature', 'refactor',
        ],
        keyQuestions: [
            '是否需要编写代码？',
            '是否需要实现功能？',
            '是否需要修改实现？',
        ],
        description: '开发阶段是核心实现阶段，包括编码、功能开发、迭代等活动。',
    },
    verify: {
        definition: '验证阶段 - 测试、评审、质量检查',
        keywords: [
            '测试', '验证', '评审', '质量', '检查',
            '覆盖率', 'lint', 'review', 'e2e',
            'verify', 'test', 'quality', 'review', 'coverage',
        ],
        keyQuestions: [
            '是否需要运行测试？',
            '是否需要代码评审？',
            '是否需要质量分析？',
        ],
        description: '验证阶段确保代码质量，包括测试、评审、静态检查等活动。',
    },
    deploy: {
        definition: '部署阶段 - 发布、上线、回滚',
        keywords: [
            '发布', '部署', '上线', '环境', '配置',
            'release', 'deploy', 'rollback', '上线部署',
            'deploy', 'release', 'rollback', 'environment',
        ],
        keyQuestions: [
            '是否需要发布？',
            '是否需要部署？',
            '是否需要环境配置？',
        ],
        description: '部署阶段将代码推送到生产环境，包括发布、环境配置、回滚等活动。',
    },
    fix: {
        definition: '修复阶段 - Bug 诊断、问题修复',
        keywords: [
            'bug', '修复', '问题', '诊断', '调试',
            'patch', 'fix', 'debug', 'bugfix', '修复Bug',
            'fix', 'bug', 'debug', 'diagnose', 'patch',
        ],
        keyQuestions: [
            '是否需要诊断 Bug？',
            '是否需要修复问题？',
            '是否需要验证修复？',
        ],
        description: '修复阶段处理问题，包括 Bug 诊断、问题修复、验证等活动。',
    },
    govern: {
        definition: '治理阶段 - 审计、约束、进化',
        keywords: [
            '审计', '约束', '进化', '治理', '合规',
            'audit', 'constraint', 'evolution', '投票', 'govern',
            'govern', 'audit', 'constraint', 'evolution', 'compliance',
        ],
        keyQuestions: [
            '是否需要审计检查？',
            '是否需要约束验证？',
            '是否需要进化改进？',
        ],
        description: '治理阶段管理长期演进，包括审计、约束检查、进化等活动。',
    },
};
/**
 * 关键词提取（方便单独使用）
 */
export const STAGE_KEYWORDS = {
    plan: STAGE_DEFINITIONS.plan.keywords,
    develop: STAGE_DEFINITIONS.develop.keywords,
    verify: STAGE_DEFINITIONS.verify.keywords,
    deploy: STAGE_DEFINITIONS.deploy.keywords,
    fix: STAGE_DEFINITIONS.fix.keywords,
    govern: STAGE_DEFINITIONS.govern.keywords,
};
/**
 * 关键问题提取（方便单独使用）
 */
export const STAGE_KEY_QUESTIONS = {
    plan: STAGE_DEFINITIONS.plan.keyQuestions,
    develop: STAGE_DEFINITIONS.develop.keyQuestions,
    verify: STAGE_DEFINITIONS.verify.keyQuestions,
    deploy: STAGE_DEFINITIONS.deploy.keyQuestions,
    fix: STAGE_DEFINITIONS.fix.keyQuestions,
    govern: STAGE_DEFINITIONS.govern.keyQuestions,
};
/**
 * 根据 name + description 推荐 Stage
 *
 * @param name 任务名称
 * @param description 任务描述
 * @returns 推荐的 Stage 列表（按分数排序）
 */
export function suggestStage(name, description = '') {
    const suggestions = [];
    for (const [stage, def] of Object.entries(STAGE_DEFINITIONS)) {
        let score = 0;
        const matchedKeywords = [];
        // 1. 名称匹配（权重 3）
        for (const kw of def.keywords) {
            if (name.toLowerCase().includes(kw.toLowerCase())) {
                score += 3;
                matchedKeywords.push(kw);
            }
        }
        // 2. 描述匹配（权重 1）
        for (const kw of def.keywords) {
            if (description.toLowerCase().includes(kw.toLowerCase())) {
                score += 1;
                matchedKeywords.push(kw);
            }
        }
        // 3. 去重
        const uniqueMatched = [...new Set(matchedKeywords)];
        if (score > 0) {
            suggestions.push({
                stage,
                score,
                matchedKeywords: uniqueMatched,
            });
        }
    }
    // 按分数排序，返回 Stage 列表
    return suggestions
        .sort((a, b) => b.score - a.score)
        .map(s => s.stage);
}
/**
 * 验证 Tool 的 stage 字段
 *
 * @param stage stage 字段值
 * @param name 任务名称（用于推荐）
 * @param description 任务描述（用于推荐）
 */
export function validateStageField(stage, name, description) {
    const result = {
        valid: true,
        errors: [],
        warnings: [],
        suggestions: [],
    };
    // 1. stage 未设置
    if (!stage) {
        result.valid = false;
        result.errors.push('stage 字段缺失');
        // 提供推荐
        if (name) {
            result.suggestions = suggestStage(name, description || '');
            result.warnings.push(`推荐: ${result.suggestions.join(', ')}`);
        }
        return result;
    }
    // 2. stage 值验证
    const validStages = ['plan', 'develop', 'verify', 'deploy', 'fix', 'govern'];
    if (!validStages.includes(stage)) {
        result.valid = false;
        result.errors.push(`stage "${stage}" 不是有效阶段`);
        result.errors.push(`有效值: ${validStages.join(', ')}`);
    }
    return result;
}
/**
 * 获取 Stage 定义
 */
export function getStageDefinition(stage) {
    return STAGE_DEFINITIONS[stage];
}
/**
 * 获取所有 Stage 名称列表
 */
export function getAllStages() {
    return Object.keys(STAGE_DEFINITIONS);
}
//# sourceMappingURL=stage-definitions.js.map