/**
 * Harness 约束服务
 *
 * 本地封装 @dommaker/harness，提供约束检查和检查点验证
 * 不依赖 agent-runtime，可独立运行
 */
import { InputGuardrail, OutputGuardrail, ToolGuardrail, Sandbox, type Constraint, type ConstraintResult, type ConstraintContext, type ConstraintCheckResult, type Checkpoint, type CheckpointResult, type CheckpointContext } from '@dommaker/harness';
/**
 * 约束服务（三层：Iron Laws / Guidelines / Tips）
 */
export declare class ConstraintService {
    /**
     * 获取所有约束
     */
    getAllConstraints(): Constraint[];
    /**
     * 获取 Iron Laws
     */
    getIronLaws(): Record<string, Constraint>;
    /**
     * 获取 Guidelines
     */
    getGuidelines(): Record<string, Constraint>;
    /**
     * 获取 Tips
     */
    getTips(): Record<string, Constraint>;
    /**
     * 获取约束列表（数组格式）
     */
    getConstraintList(): Constraint[];
    /**
     * @deprecated 使用 getConstraintList 代替
     */
    getLawList(): Constraint[];
    /**
     * @deprecated 使用 getConstraintById 代替
     */
    getLawById(id: string): Constraint | undefined;
    /**
     * 获取单个约束
     */
    getConstraintById(id: string): Constraint | undefined;
    /**
     * 检查约束是否满足
     */
    checkConstraint(id: string, context: ConstraintContext): Promise<ConstraintResult>;
    /**
     * @deprecated 使用 checkConstraint 代替
     */
    checkLaw(id: string, context: ConstraintContext): Promise<ConstraintResult>;
    /**
     * 执行三层约束检查
     */
    checkConstraints(context: ConstraintContext): Promise<ConstraintCheckResult>;
    /**
     * @deprecated 使用 checkConstraints 代替
     */
    checkAllLaws(context: ConstraintContext): Promise<ConstraintCheckResult>;
    /**
     * 批量检查约束
     */
    checkMultipleConstraints(ids: string[], context: ConstraintContext): Promise<Record<string, ConstraintResult>>;
    /**
     * @deprecated 使用 checkMultipleConstraints 代替
     */
    checkMultipleLaws(ids: string[], context: ConstraintContext): Promise<Record<string, ConstraintResult>>;
}
export type IronLawService = ConstraintService;
export { formatConstraintsForPrompt } from './prompt-injection';
export type { AgentRole } from './prompt-injection';
/**
 * 检查点服务
 */
export declare class CheckpointService {
    private validator;
    constructor();
    /**
     * 获取支持的检查类型
     */
    getSupportedCheckTypes(): string[];
    /**
     * 验证检查点
     */
    validateCheckpoint(checkpoint: Checkpoint, context: CheckpointContext): Promise<CheckpointResult>;
    /**
     * 批量验证检查点
     */
    validateMultiple(checkpoints: Checkpoint[], context: CheckpointContext): Promise<CheckpointResult[]>;
}
export declare const constraintService: ConstraintService;
export declare const ironLawService: ConstraintService;
export declare const checkpointService: CheckpointService;
/**
 * 安全护栏服务
 */
export declare class SafetyService {
    private inputGuardrail;
    private outputGuardrail;
    private toolGuardrail;
    private sandbox;
    constructor();
    getInputGuardrail(): InputGuardrail;
    getOutputGuardrail(): OutputGuardrail;
    getToolGuardrail(): ToolGuardrail;
    getSandbox(): Sandbox;
}
export { parseSessionMetrics, estimateTokens } from './session-metrics';
export type { SessionMetrics } from './session-metrics';
export declare const safetyService: SafetyService;
export { bootstrapHarness, getHarness, getPipeline, isHarnessInitialized } from './runtime/bootstrap';
export type { HarnessBootstrap } from '@dommaker/harness';
export * from './hooks/index';
//# sourceMappingURL=index.d.ts.map