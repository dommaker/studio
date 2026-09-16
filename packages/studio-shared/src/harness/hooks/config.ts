/**
 * Per-Hook 声明表（A4：HookConfig 归一为 harness 形状 {name,enabled,errorStrategy}）
 *
 * - #159 起本表是 enabled/errorStrategy 的**唯一声明点**：HookDefinition 不再
 *   携带这两个字段，有效值在注册环节由本表填充（harness EffectiveHook），
 *   判定只住在 harness 管线（HookPipeline 读注册表有效值）。原 runHook
 *   自建判定层已拆除——直接调 hook 函数不再自带 enabled 门，管线外调用
 *   等价于绕过判定（生产路径全部经管线，见 runtime/bootstrap.ts）。
 * - 声明表是注册表闭环（assertHookRegistryClosed）的「声明」侧：只含经
 *   registerAllHooks 注册进管线的 7 个 hook。buildAgentConstraintPrompt 是同步
 *   直接调用助手（不进管线），不在声明表中。
 * - blocking 仅作为声明表内的映射源存在：经 harness `toErrorStrategy` 无损映射为
 *   errorStrategy（blocking=true → 'block' 阻断管线 / false → 'warn' 记录警告继续），
 *   对外的 HookConfig 形状不含 blocking 字段。
 * - 配置来源（优先级从高到低）：
 *   1. 环境变量 HARNESS_HOOK_DISABLE=hook1,hook2（保留 studio 侧开关）
 *   2. 本文件声明表
 */

import { toErrorStrategy } from '@dommaker/harness';
import type { HookConfig } from '@dommaker/harness';

export type { HookConfig };

/** 映射源表：blocking（失败是否阻断）→ errorStrategy 的唯一映射点 */
const DECLARATIONS: ReadonlyArray<{ name: string; enabled: boolean; blocking: boolean }> = [
  // Goal phase
  { name: 'beforeGoalCreate', enabled: true, blocking: false },       // Phase 5: 非阻断（Guideline 级别）
  { name: 'beforeAgentDispatch', enabled: true, blocking: false },    // 非阻断（Guideline 级别）

  // Agent phase
  { name: 'beforeAgentExecute', enabled: true, blocking: true },
  { name: 'afterAgentComplete', enabled: true, blocking: false },

  // Completion phase
  { name: 'checkBeforeTaskComplete', enabled: true, blocking: true }, // Goal 完成前检查 worktree 测试结果
  { name: 'afterReview', enabled: true, blocking: false },            // 审查结果写入 TraceCollector + FailureRecorder

  // PR phase
  { name: 'afterPrCreated', enabled: true, blocking: false },         // PR 创建后：门禁检查（待 GateChecker 全量接入）
];

/** 从环境变量解析禁用列表 */
function parseDisableList(): Set<string> {
  const env = process.env.HARNESS_HOOK_DISABLE || '';
  return new Set(env.split(',').map(s => s.trim()).filter(Boolean));
}

/** 获取全部 hook 声明（enabled 已并入 HARNESS_HOOK_DISABLE 覆盖） */
export function getAllHookConfigs(): HookConfig[] {
  const disabled = parseDisableList();
  return DECLARATIONS.map(({ name, enabled, blocking }) => ({
    name,
    enabled: enabled && !disabled.has(name),
    errorStrategy: toErrorStrategy(blocking),
  }));
}

/** 获取单个 hook 声明（未知名 → 默认 disabled + warn） */
export function getHookConfig(name: string): HookConfig {
  const config = getAllHookConfigs().find(c => c.name === name);
  return config ?? { name, enabled: false, errorStrategy: 'warn' };
}
