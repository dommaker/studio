/**
 * Harness 约束服务
 *
 * 本地封装 @dommaker/harness，提供约束检查和检查点验证
 * 不依赖 agent-runtime，可独立运行
 */
import { constraintChecker, getAllConstraints, getConstraint, checkConstraint, IRON_LAWS, GUIDELINES, TIPS, CheckpointValidator, InputGuardrail, OutputGuardrail, ToolGuardrail, Sandbox, } from '@dommaker/harness';
import { logger } from '../utils';
/**
 * 约束服务（三层：Iron Laws / Guidelines / Tips）
 */
export class ConstraintService {
    /**
     * 获取所有约束
     */
    getAllConstraints() {
        return getAllConstraints();
    }
    /**
     * 获取 Iron Laws
     */
    getIronLaws() {
        return IRON_LAWS;
    }
    /**
     * 获取 Guidelines
     */
    getGuidelines() {
        return GUIDELINES;
    }
    /**
     * 获取 Tips
     */
    getTips() {
        return TIPS;
    }
    /**
     * 获取约束列表（数组格式）
     */
    getConstraintList() {
        return getAllConstraints();
    }
    // ========================================
    // 向后兼容的方法
    // ========================================
    /**
     * @deprecated 使用 getConstraintList 代替
     */
    getLawList() {
        return this.getConstraintList();
    }
    /**
     * @deprecated 使用 getConstraintById 代替
     */
    getLawById(id) {
        return this.getConstraintById(id);
    }
    /**
     * 获取单个约束
     */
    getConstraintById(id) {
        return getConstraint(id);
    }
    /**
     * 检查约束是否满足
     */
    async checkConstraint(id, context) {
        try {
            const result = await checkConstraint(id, context);
            logger.debug('Constraint check result', { constraintId: id, result });
            return result;
        }
        catch (error) {
            logger.error('Constraint check failed', { constraintId: id, error });
            throw error;
        }
    }
    /**
     * @deprecated 使用 checkConstraint 代替
     */
    async checkLaw(id, context) {
        return this.checkConstraint(id, context);
    }
    /**
     * 执行三层约束检查
     */
    async checkConstraints(context) {
        try {
            const result = await constraintChecker.checkConstraints(context);
            logger.debug('Constraint check result', { context, result });
            return result;
        }
        catch (error) {
            logger.error('Constraint check failed', { context, error });
            throw error;
        }
    }
    /**
     * @deprecated 使用 checkConstraints 代替
     */
    async checkAllLaws(context) {
        return this.checkConstraints(context);
    }
    /**
     * 批量检查约束
     */
    async checkMultipleConstraints(ids, context) {
        const results = {};
        for (const id of ids) {
            results[id] = await this.checkConstraint(id, context);
        }
        return results;
    }
    /**
     * @deprecated 使用 checkMultipleConstraints 代替
     */
    async checkMultipleLaws(ids, context) {
        return this.checkMultipleConstraints(ids, context);
    }
}
// Prompt injection — 约束前置声明注入 Agent prompt
export { formatConstraintsForPrompt } from './prompt-injection';
/**
 * 检查点服务
 */
export class CheckpointService {
    validator;
    constructor() {
        this.validator = CheckpointValidator.getInstance();
    }
    /**
     * 获取支持的检查类型
     */
    getSupportedCheckTypes() {
        return this.validator.getSupportedCheckTypes();
    }
    /**
     * 验证检查点
     */
    async validateCheckpoint(checkpoint, context) {
        try {
            const result = await this.validator.validate(checkpoint, context);
            logger.debug('Checkpoint validation result', { checkpoint, result });
            return result;
        }
        catch (error) {
            logger.error('Checkpoint validation failed', { checkpoint, error });
            throw error;
        }
    }
    /**
     * 批量验证检查点
     */
    async validateMultiple(checkpoints, context) {
        const results = [];
        for (const checkpoint of checkpoints) {
            results.push(await this.validateCheckpoint(checkpoint, context));
        }
        return results;
    }
}
// 导出单例
export const constraintService = new ConstraintService();
export const ironLawService = constraintService; // 向后兼容
export const checkpointService = new CheckpointService();
// ========================================
// Phase 1-6 新增服务
// ========================================
/**
 * 安全护栏服务
 */
export class SafetyService {
    inputGuardrail;
    outputGuardrail;
    toolGuardrail;
    sandbox;
    constructor() {
        this.inputGuardrail = new InputGuardrail();
        this.outputGuardrail = new OutputGuardrail();
        this.sandbox = new Sandbox();
        this.toolGuardrail = new ToolGuardrail(this.sandbox);
    }
    getInputGuardrail() { return this.inputGuardrail; }
    getOutputGuardrail() { return this.outputGuardrail; }
    getToolGuardrail() { return this.toolGuardrail; }
    getSandbox() { return this.sandbox; }
}
// Session metrics (observability)
export { parseSessionMetrics, estimateTokens } from './session-metrics';
// Phase 1-6 服务单例
export const safetyService = new SafetyService();
// Harness 运行时 & Hooks（Phase 2: 迁移到新 hooks 管线）
export { bootstrapHarness, getHarness, getPipeline, isHarnessInitialized } from './runtime/bootstrap';
export * from './hooks/index';
// Wiki 服务已移除 (B11-002): KnowledgeKeeper/wiki-service/knowledge-query
// 知识系统统一使用 harness KnowledgeStore + KnowledgeBus
//# sourceMappingURL=index.js.map