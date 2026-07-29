/**
 * Harness Runtime Bootstrap — Phase 2 迁移
 *
 * 使用 harness 新 hooks 管线 (HookRegistry + HookPipeline) 替代 ad-hoc import。
 * 启动时加载 .harness/config.yml，初始化 ConstraintChecker 并注册所有 hook。
 */
import { HookPipeline } from '@dommaker/harness';
import type { HarnessBootstrap } from '@dommaker/harness';
/**
 * 初始化 harness 运行时（Phase 2: 使用新 hooks 管线）
 * 应在 API 服务器启动时调用一次
 */
export declare function bootstrapHarness(projectPath?: string): Promise<HarnessBootstrap>;
/**
 * 获取已初始化的 harness 实例
 */
export declare function getHarness(): HarnessBootstrap | null;
/**
 * 获取 hook 管线（用于执行业务 hook）
 */
export declare function getPipeline(): HookPipeline | null;
export declare function isHarnessInitialized(): boolean;
//# sourceMappingURL=bootstrap.d.ts.map