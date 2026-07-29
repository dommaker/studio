/**
 * 级别配置 - 全局统一的职级定义
 *
 * 各模块（role, economy, assessment, career, frontend）共用此配置，
 * 避免在 5+ 处重复定义导致数据不一致。
 */
export interface LevelConfig {
    capabilityLimit: number;
    salary: number;
    minTasks: number;
    minQuality: number;
    color: string;
    name: string;
}
export declare const LEVEL_CONFIG: Record<number, LevelConfig>;
export declare const MIN_LEVEL = 1;
export declare const MAX_LEVEL = 4;
/** 获取级别配置，若级别无效则返回 L1 配置 */
export declare function getLevelConfig(level: number): LevelConfig;
/** 获取级别薪资 */
export declare function getLevelSalary(level: number): number;
/** 获取级别能力上限 */
export declare function getLevelCapabilityLimit(level: number): number;
/** 将级别限制在有效范围内 */
export declare function clampLevel(level: number): number;
//# sourceMappingURL=levels.d.ts.map