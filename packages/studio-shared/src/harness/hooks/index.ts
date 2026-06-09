/**
 * Harness Integration Hooks
 *
 * 每个执行阶段的 hook 定义。被 apps/api 和 packages/ 统一调用，
 * 替代散落在 20+ 文件中的 ad-hoc harness import。
 *
 * Phase 2: 新增 registerAllHooks() 将 hook 注册到 harness HookPipeline。
 */

export * from './goal.hooks';
export * from './agent.hooks';
export * from './completion.hooks';
export * from './pr.hooks';
export * from './meeting.hooks';
export * from './audit';
export { registerAllHooks } from './register';
