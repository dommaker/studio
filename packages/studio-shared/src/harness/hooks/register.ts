/**
 * Hook 注册 — Phase 2 迁移
 *
 * 将现有 business hook 函数转换为 harness HookDefinition 并注册到 HookRegistry。
 * 保持现有 exports 不变（函数仍可直接调用），同时提供 pipeline 集成路径。
 *
 * C1：注册 = 各 hook 模块导出的 HookDefinition 并集（导出即注册），不再手工
 * 维护 7 条清单；enabled/errorStrategy 统一按 hooks/config.ts 声明表合并。
 * 注册表闭环（assertHookRegistryClosed）对 getAllHookConfigs() ↔
 * buildHookDefinitions() 双向校验：测试期见 hooks/__tests__/config.test.ts，
 * 构建期见 scripts/tools/hooks-closure-check.ts（挂 studio-shared build）。
 */

import type { HookRegistry, HookDefinition } from '@dommaker/harness';
import { getHookConfig } from './config';

import { goalHookDefinitions } from './goal.hooks';
import { agentHookDefinitions } from './agent.hooks';
import { completionHookDefinitions } from './completion.hooks';
import { prHookDefinitions } from './pr.hooks';

// ── 注册到 HookRegistry ──

/** 各模块自带的全部定义（导出即注册） */
const MODULE_DEFINITIONS: HookDefinition[] = [
  ...goalHookDefinitions,
  ...agentHookDefinitions,
  ...completionHookDefinitions,
  ...prHookDefinitions,
];

/** 聚合模块导出定义并合并声明表 enabled/errorStrategy（注册表闭环断言用） */
export function buildHookDefinitions(): HookDefinition[] {
  return MODULE_DEFINITIONS.map(def => {
    const config = getHookConfig(def.name);
    return { ...def, enabled: config.enabled, errorStrategy: config.errorStrategy };
  });
}

export function registerAllHooks(registry: HookRegistry): void {
  registry.registerAll(buildHookDefinitions());
}
