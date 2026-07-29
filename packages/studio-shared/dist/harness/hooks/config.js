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
const DEFAULTS = [
    // Goal phase
    { name: 'beforeGoalCreate', enabled: true, blocking: false }, // Phase 5: 非阻断（Guideline 级别）
    { name: 'beforeAgentDispatch', enabled: true, blocking: false }, // 非阻断（Guideline 级别）
    // Agent phase
    { name: 'beforeAgentExecute', enabled: true, blocking: true },
    { name: 'buildAgentConstraintPrompt', enabled: true, blocking: false },
    { name: 'afterAgentComplete', enabled: true, blocking: false },
    // Completion phase
    { name: 'checkBeforeTaskComplete', enabled: true, blocking: true }, // Goal 完成前检查 worktree 测试结果
    { name: 'afterReview', enabled: true, blocking: false }, // 审查结果写入 TraceCollector + FailureRecorder
    // PR phase
    { name: 'afterPrCreated', enabled: true, blocking: false }, // PR 创建后：门禁检查（待 GateChecker 全量接入）
];
/** 从环境变量解析禁用列表 */
function parseDisableList() {
    const env = process.env.HARNESS_HOOK_DISABLE || '';
    return new Set(env.split(',').map(s => s.trim()).filter(Boolean));
}
/** 获取 hook 配置 */
export function getHookConfig(name) {
    const disabled = parseDisableList();
    const config = DEFAULTS.find(c => c.name === name);
    if (!config)
        return { name, enabled: false, blocking: false };
    return {
        ...config,
        enabled: config.enabled && !disabled.has(name),
    };
}
/** 安全调用 hook：根据配置决定是否执行 + 如何处理失败 */
export async function safeCallHook(name, fn) {
    const config = getHookConfig(name);
    if (!config.enabled)
        return;
    try {
        await fn();
    }
    catch (err) {
        if (config.blocking)
            throw err;
        console.warn(`[HarnessHook] ${name} failed (non-blocking):`, err.message);
    }
}
/** 获取所有 hook 配置（用于覆盖率报告） */
export function getAllHookConfigs() {
    const disabled = parseDisableList();
    return DEFAULTS.map(c => ({
        ...c,
        enabled: c.enabled && !disabled.has(c.name),
    }));
}
//# sourceMappingURL=config.js.map