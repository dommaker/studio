/**
 * Harness Runtime Bootstrap — Phase 2 迁移
 *
 * 使用 harness 新 hooks 管线 (HookRegistry + HookPipeline) 替代 ad-hoc import。
 * 启动时加载 .harness/config.yml，初始化 ConstraintChecker 并注册所有 hook。
 */
import { bootstrapHarness as harnessBootstrap } from '@dommaker/harness';
import { registerAllHooks } from '../hooks/register';
let bootstrap = null;
/**
 * 初始化 harness 运行时（Phase 2: 使用新 hooks 管线）
 * 应在 API 服务器启动时调用一次
 */
export async function bootstrapHarness(projectPath) {
    if (bootstrap)
        return bootstrap;
    const root = projectPath || process.cwd();
    try {
        // Phase 2: 使用 harness 新 bootstrap（异步加载配置，解决 S9）
        bootstrap = await harnessBootstrap(root);
        // 注册所有 business hooks 到管线
        registerAllHooks(bootstrap.hooks);
        console.log(`[Harness] Bootstrap complete — project: ${root}, hooks: ${bootstrap.hooks.size}`);
        return bootstrap;
    }
    catch (err) {
        console.warn('[Harness] Bootstrap failed:', err.message);
        // Fallback: 同步初始化
        const { bootstrapHarnessSync } = await import('@dommaker/harness');
        bootstrap = bootstrapHarnessSync(root);
        registerAllHooks(bootstrap.hooks);
        return bootstrap;
    }
}
/**
 * 获取已初始化的 harness 实例
 */
export function getHarness() {
    return bootstrap;
}
/**
 * 获取 hook 管线（用于执行业务 hook）
 */
export function getPipeline() {
    return bootstrap?.pipeline ?? null;
}
export function isHarnessInitialized() {
    return bootstrap !== null;
}
//# sourceMappingURL=bootstrap.js.map