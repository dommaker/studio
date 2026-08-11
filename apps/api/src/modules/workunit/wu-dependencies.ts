/**
 * #109（T3，#106 子票）WU 接单依赖（blockedBy）解析与可认领判定。
 *
 * 接单规则机制化：metadata.blockedBy 列出阻塞本 WU 的 WU id（可跨 PMO），
 * 任一依赖未 done → 该任务单不可认领（M4：agent-loop observe 的 unassigned
 * 过滤据此剔除；WU 列表 API 据此返回 claimable 标记供 UI 使用）。
 *
 * 本模块是零运行时依赖的叶子（仅 type import），agent-loop 与 workunit 路由共用。
 */

import type { WorkUnitData } from './workunit.types.js';

/**
 * 容错解析 metadata.blockedBy：字符串/对象入参皆可；缺失/坏 JSON/非数组 → []；
 * 数组内非字符串与空串项剔除。绝不抛异常（同 parseExcludeAssignee 口径）。
 */
export function parseBlockedBy(metadata: unknown): string[] {
  try {
    const m = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
    const v = (m as { blockedBy?: unknown } | null)?.blockedBy;
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === 'string' && x.length > 0);
  } catch {
    return [];
  }
}

/**
 * M4 接单过滤核心判定：blockedBy 中有未 done 的 WU → true（不可认领）。
 * statusById 为全局 WU id → status 映射（FileStore index 天然跨 PMO）；
 * 严格 done 口径：closed/in_review 等均算未完结；引用缺失 id（已删除/笔误）
 * 保守按未 done 处理 —— 宁可不可见，不提前放行。
 */
export function hasUnfinishedDeps(metadata: unknown, statusById: ReadonlyMap<string, string>): boolean {
  return parseBlockedBy(metadata).some(id => statusById.get(id) !== 'done');
}

/**
 * 列表 API 的「可认领」标记：status=unassigned 且无未完结依赖。
 * profile 无关 —— 不含 assigneeId/频道作用域判定（那需要具体 profile 上下文，
 * 仍由 agent-loop observe 在认领侧执行）。
 */
export function resolveClaimable(
  wu: Pick<WorkUnitData, 'status' | 'metadata'>,
  statusById: ReadonlyMap<string, string>,
): boolean {
  return wu.status === 'unassigned' && !hasUnfinishedDeps(wu.metadata, statusById);
}
