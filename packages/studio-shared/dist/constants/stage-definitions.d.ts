/**
 * Stage Definitions - 阶段定义 + 关键词 + 推荐函数
 *
 * @see docs/responsibility-chain-design.md
 */
import { Stage } from './responsibility-chain';
/**
 * Stage 详细定义
 */
export interface StageDefinition {
    definition: string;
    keywords: string[];
    keyQuestions: string[];
    description?: string;
}
/**
 * 各阶段定义（单一数据源）
 */
export declare const STAGE_DEFINITIONS: Record<Stage, StageDefinition>;
/**
 * 关键词提取（方便单独使用）
 */
export declare const STAGE_KEYWORDS: Record<Stage, string[]>;
/**
 * 关键问题提取（方便单独使用）
 */
export declare const STAGE_KEY_QUESTIONS: Record<Stage, string[]>;
/**
 * Stage 推荐结果
 */
export interface StageSuggestion {
    stage: Stage;
    score: number;
    matchedKeywords: string[];
}
/**
 * 根据 name + description 推荐 Stage
 *
 * @param name 任务名称
 * @param description 任务描述
 * @returns 推荐的 Stage 列表（按分数排序）
 */
export declare function suggestStage(name: string, description?: string): Stage[];
/**
 * 验证 stage 字段
 */
export interface StageValidationResult {
    valid: boolean;
    errors: string[];
    warnings: string[];
    suggestions: Stage[];
}
/**
 * 验证 Tool 的 stage 字段
 *
 * @param stage stage 字段值
 * @param name 任务名称（用于推荐）
 * @param description 任务描述（用于推荐）
 */
export declare function validateStageField(stage: string | undefined, name?: string, description?: string): StageValidationResult;
/**
 * 获取 Stage 定义
 */
export declare function getStageDefinition(stage: Stage): StageDefinition;
/**
 * 获取所有 Stage 名称列表
 */
export declare function getAllStages(): Stage[];
//# sourceMappingURL=stage-definitions.d.ts.map