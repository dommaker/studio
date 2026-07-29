/**
 * Hook 注册 — Phase 2 迁移
 *
 * 将现有 business hook 函数转换为 harness HookDefinition 并注册到 HookRegistry。
 * 保持现有 exports 不变（函数仍可直接调用），同时提供 pipeline 集成路径。
 */
import type { HookRegistry } from '@dommaker/harness';
export declare function registerAllHooks(registry: HookRegistry): void;
//# sourceMappingURL=register.d.ts.map