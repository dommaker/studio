/**
 * Constraint Check Cache（S7 修复）
 *
 * git diff + src/ 递归扫描是性能瓶颈（500ms-2s/次）。
 * 缓存相同 projectPath 的检查结果，TTL 内复用。
 *
 * 缓存键 = projectPath + operation（同项目同操作的短时间重复调用可命中）
 */
/**
 * 带缓存的约束检查包装器
 *
 * @param key 缓存键（如 `${projectPath}:${operation}`）
 * @param fn 实际检查函数
 * @param ttlMs 缓存 TTL
 */
export declare function cachedCheck(key: string, fn: () => Promise<boolean>, ttlMs?: number): Promise<boolean>;
/**
 * 带采样的约束检查（S7 性能优化）
 *
 * 非关键 hook（guideline 级别）使用采样模式减少 I/O：
 * - 每 N 次执行 1 次完整检查
 * - 其余 N-1 次返回上次缓存结果
 */
export declare function sampledCheck(key: string, fn: () => Promise<boolean>, sampleRate?: number): Promise<boolean>;
/** 清除所有缓存 */
export declare function clearConstraintCache(): void;
/** 获取缓存统计 */
export declare function getCacheStats(): {
    size: number;
    keys: string[];
};
//# sourceMappingURL=cache.d.ts.map