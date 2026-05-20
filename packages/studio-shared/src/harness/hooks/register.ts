/**
 * Hook 注册 — Phase 2 迁移
 *
 * 将现有 business hook 函数转换为 harness HookDefinition 并注册到 HookRegistry。
 * 保持现有 exports 不变（函数仍可直接调用），同时提供 pipeline 集成路径。
 */

import type { HookRegistry, HookDefinition } from '@dommaker/harness';
import { getHookConfig } from './config';

// ── 导入所有 hook 函数 ──

import { afterMeetingDecision, afterRequirementsDoc } from './meeting.hooks';
import { beforeGoalCreate, beforeAgentDispatch } from './goal.hooks';
import {
  beforeAgentExecute,
  buildAgentConstraintPrompt,
  afterAgentComplete,
} from './agent.hooks';
import { checkBeforeTaskComplete, afterReview } from './completion.hooks';
import { afterPrCreated } from './pr.hooks';

// ── 注册到 HookRegistry ──

export function registerAllHooks(registry: HookRegistry): void {
  const hooks: HookDefinition[] = [
    // Meeting phase
    toHookDef('afterMeetingDecision', 'after', afterMeetingDecision, true),
    toHookDef('afterRequirementsDoc', 'after', afterRequirementsDoc, false),

    // Goal phase
    toHookDef('beforeGoalCreate', 'before', beforeGoalCreate, false),
    toHookDef('beforeAgentDispatch', 'before', beforeAgentDispatch, false),

    // Agent phase
    toHookDef('beforeAgentExecute', 'before', beforeAgentExecute, true),
    toHookDef('afterAgentComplete', 'after', afterAgentComplete, false),
    // buildAgentConstraintPrompt is synchronous, not registered as async hook

    // Completion phase
    toHookDef('checkBeforeTaskComplete', 'before', checkBeforeTaskComplete, true),
    toHookDef('afterReview', 'after', afterReview, false),

    // PR phase
    toHookDef('afterPrCreated', 'after', afterPrCreated, false),
  ];

  registry.registerAll(hooks);
}

function toHookDef(
  name: string,
  phase: 'before' | 'after',
  fn: (...args: any[]) => Promise<any>,
  blocking: boolean,
): HookDefinition {
  const config = getHookConfig(name);
  return {
    name,
    phase,
    enabled: config.enabled,
    errorStrategy: blocking ? 'block' : 'warn',
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
