/**
 * Hook 注册 — Phase 2 迁移（#159：注册 = 定义与声明表配对）
 *
 * 将现有 business hook 函数转换为 harness HookDefinition 并注册到 HookRegistry。
 *
 * C1：注册 = 各 hook 模块导出的 HookDefinition 并集（导出即注册），不再手工
 * 维护 7 条清单。#159 起 HookDefinition 不携带 enabled/errorStrategy——
 * 唯一声明点是 hooks/config.ts 声明表，注册时随 registerAll 配对传入，
 * 有效值（EffectiveHook）由 harness 注册表填充、管线判定。
 * 注册表闭环（assertHookRegistryClosed）对 getAllHookConfigs() ↔
 * buildHookDefinitions() 双向校验：测试期见 hooks/__tests__/config.test.ts，
 * 构建期见 scripts/tools/hooks-closure-check.ts（挂 studio-shared build）。
 */

import type { HookRegistry, HookDefinition } from '@dommaker/harness';
import { getAllHookConfigs } from './config';

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

/** 聚合模块导出定义（#159 起定义不携带 enabled/errorStrategy，纯实现侧） */
export function buildHookDefinitions(): HookDefinition[] {
  return [...MODULE_DEFINITIONS];
}

/**
 * 批量注册 = 定义 ↔ 声明表配对（harness registerAll 按 name 配对，
 * 有实现缺声明即抛错；enabled/errorStrategy 由声明表填充）
 */
export function registerAllHooks(registry: HookRegistry): void {
  registry.registerAll(buildHookDefinitions(), getAllHookConfigs());
}
