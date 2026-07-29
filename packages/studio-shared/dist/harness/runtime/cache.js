/**
 * Constraint Check Cache（S7 修复）
 *
 * git diff + src/ 递归扫描是性能瓶颈（500ms-2s/次）。
 * 缓存相同 projectPath 的检查结果，TTL 内复用。
 *
 * 缓存键 = projectPath + operation（同项目同操作的短时间重复调用可命中）
 */
const cache = new Map();
/** 默认 TTL：30 秒（GoalScheduler 10s tick 可命中 2-3 次） */
const DEFAULT_TTL_MS = 30_000;
/** 采样计数器：每 N 次完整检查后采样一次 */
const sampleCounters = new Map();
const DEFAULT_SAMPLE_RATE = 3; // 每 3 次执行 1 次完整检查
/**
 * 带缓存的约束检查包装器
 *
 * @param key 缓存键（如 `${projectPath}:${operation}`）
 * @param fn 实际检查函数
 * @param ttlMs 缓存 TTL
 */
export async function cachedCheck(key, fn, ttlMs = DEFAULT_TTL_MS) {
    const entry = cache.get(key);
    if (entry && Date.now() - entry.timestamp < ttlMs) {
        return entry.result;
    }
    const result = await fn();
    cache.set(key, { result, timestamp: Date.now() });
    return result;
}
/**
 * 带采样的约束检查（S7 性能优化）
 *
 * 非关键 hook（guideline 级别）使用采样模式减少 I/O：
 * - 每 N 次执行 1 次完整检查
 * - 其余 N-1 次返回上次缓存结果
 */
export async function sampledCheck(key, fn, sampleRate = DEFAULT_SAMPLE_RATE) {
    const count = (sampleCounters.get(key) || 0) + 1;
    sampleCounters.set(key, count);
    if (count % sampleRate === 1) {
        // 采样命中：执行完整检查
        return cachedCheck(key, fn, 0); // TTL=0，不缓存采样结果
    }
    // 非采样：返回缓存
    const entry = cache.get(key);
    return entry?.result ?? true; // 无缓存时默认通过
}
/** 清除所有缓存 */
export function clearConstraintCache() {
    cache.clear();
    sampleCounters.clear();
}
/** 获取缓存统计 */
export function getCacheStats() {
    return { size: cache.size, keys: [...cache.keys()] };
}
//# sourceMappingURL=cache.js.map