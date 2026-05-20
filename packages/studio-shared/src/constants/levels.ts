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

export const LEVEL_CONFIG: Record<number, LevelConfig> = {
  1: { capabilityLimit: 10, salary: 5000,  minTasks: 0,   minQuality: 0,   color: '#4CAF50', name: 'L1 初级' },
  2: { capabilityLimit: 20, salary: 10000, minTasks: 50,  minQuality: 4.0, color: '#2196F3', name: 'L2 中级' },
  3: { capabilityLimit: 30, salary: 20000, minTasks: 100, minQuality: 4.5, color: '#FF9800', name: 'L3 高级' },
  4: { capabilityLimit: 50, salary: 40000, minTasks: 200, minQuality: 4.8, color: '#9C27B0', name: 'L4 专家' },
};

export const MIN_LEVEL = 1;
export const MAX_LEVEL = 4;

/** 获取级别配置，若级别无效则返回 L1 配置 */
export function getLevelConfig(level: number): LevelConfig {
  return LEVEL_CONFIG[level] ?? LEVEL_CONFIG[1];
}

/** 获取级别薪资 */
export function getLevelSalary(level: number): number {
  return getLevelConfig(level).salary;
}

/** 获取级别能力上限 */
export function getLevelCapabilityLimit(level: number): number {
  return getLevelConfig(level).capabilityLimit;
}

/** 将级别限制在有效范围内 */
export function clampLevel(level: number): number {
  return Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, level));
}
