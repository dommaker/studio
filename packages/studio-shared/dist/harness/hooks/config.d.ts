/**
 * Per-Hook Runtime Config（S10 修复）
 *
 * 允许按环境和阶段单独启用/禁用 hook。
 * 解决此前 interceptor 的 skip/setEnabled 只有全局粒度的问题。
 *
 * 配置来源（优先级从高到低）：
 *   1. 环境变量 HARNESS_HOOK_DISABLE=hook1,hook2
 *   2. 本文件的 DEFAULTS
 */
export interface HookConfig {
    /** hook 名称 */
    name: string;
    /** 是否启用 */
    enabled: boolean;
    /** 失败时是否阻断（true=抛异常, false=记录警告继续） */
    blocking: boolean;
}
/** 获取 hook 配置 */
export declare function getHookConfig(name: string): HookConfig;
/** 安全调用 hook：根据配置决定是否执行 + 如何处理失败 */
export declare function safeCallHook(name: string, fn: () => Promise<void>): Promise<void>;
/** 获取所有 hook 配置（用于覆盖率报告） */
export declare function getAllHookConfigs(): HookConfig[];
//# sourceMappingURL=config.d.ts.map