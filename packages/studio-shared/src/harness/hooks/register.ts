/**
 * Hook 注册 — Phase 2 迁移
 *
 * 将现有 business hook 函数转换为 harness HookDefinition 并注册到 HookRegistry。
 * 保持现有 exports 不变（函数仍可直接调用），同时提供 pipeline 集成路径。
 *
 * A4：HookDefinition 的 enabled/errorStrategy 统一取自 hooks/config.ts 声明表
 * （HookConfig{name,enabled,errorStrategy}），toHookDef 不再接收 blocking 参数；
 * 注册表闭环（assertHookRegistryClosed）对 getAllHookConfigs() ↔ buildHookDefinitions()
 * 双向校验，见 hooks/__tests__/config.test.ts 与构建期脚本。
 */

import type { HookRegistry, HookDefinition } from '@dommaker/harness';
import { getHookConfig } from './config';

// ── 导入所有 hook 函数 ──

import { beforeGoalCreate, beforeAgentDispatch } from './goal.hooks';
import {
  beforeAgentExecute,
  afterAgentComplete,
} from './agent.hooks';
import { checkBeforeTaskComplete, afterReview } from './completion.hooks';
import { afterPrCreated } from './pr.hooks';

// ── 注册到 HookRegistry ──

/** 构建全部 HookDefinition（声明表驱动的注册清单；闭环断言用） */
export function buildHookDefinitions(): HookDefinition[] {
  return [
    // Goal phase
    toHookDef('beforeGoalCreate', 'before', beforeGoalCreate),
    toHookDef('beforeAgentDispatch', 'before', beforeAgentDispatch),

    // Agent phase
    toHookDef('beforeAgentExecute', 'before', beforeAgentExecute),
    toHookDef('afterAgentComplete', 'after', afterAgentComplete),
    // buildAgentConstraintPrompt is synchronous, not registered as async hook

    // Completion phase
    toHookDef('checkBeforeTaskComplete', 'before', checkBeforeTaskComplete),
    toHookDef('afterReview', 'after', afterReview),

    // PR phase
    toHookDef('afterPrCreated', 'after', afterPrCreated),
  ];
}

export function registerAllHooks(registry: HookRegistry): void {
  registry.registerAll(buildHookDefinitions());
}

function toHookDef(
  name: string,
  phase: 'before' | 'after',
  fn: (...args: any[]) => Promise<any>,
): HookDefinition {
  const config = getHookConfig(name);
  return {
    name,
    phase,
    enabled: config.enabled,
    errorStrategy: config.errorStrategy,
    execute: async (ctx: any) => {
      const result = await fn(ctx);
      // 特殊处理: checkBeforeTaskComplete 返回 { allowed, violations }
      if (result && typeof result.allowed === 'boolean') {
        return { passed: result.allowed, data: result };
      }
      return { passed: true };
    },
  };
}
