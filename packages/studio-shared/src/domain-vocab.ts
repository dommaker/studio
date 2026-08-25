/**
 * 职能域词表（决策 8，docs/plans/2026-07-27-agents-md-skill-governance.md）
 *
 * 阶段导向单一词表：角色 acceptedTypes、WU type、skill agentTypes 统一归一化到
 * 阶段名后求交集。legacy 类型归一化：feature/bug→implement、task→general。
 * 归一化函数单处实现（本文件），调用方不得各自维护映射。
 */

/** 阶段词表（单一事实源） */
export const STAGE_TYPES = ['design', 'plan', 'implement', 'review', 'docs', 'refactor', 'analysis', 'general'] as const;

export type StageType = (typeof STAGE_TYPES)[number];

/** legacy 类型 → 阶段名映射 */
const LEGACY_STAGE_MAP: Record<string, StageType> = {
  feature: 'implement',
  bug: 'implement',
  task: 'general',
};

/**
 * 归一化到阶段词表：
 * - 阶段名（大小写不敏感）原样通过（统一返回小写）
 * - feature/bug → 'implement'；task → 'general'
 * - 其他未知值原样返回（容错——不丢信息，由匹配方自行判断交集）
 */
export function normalizeToStage(type: string): string {
  const lower = type.toLowerCase();
  if ((STAGE_TYPES as readonly string[]).includes(lower)) return lower;
  return LEGACY_STAGE_MAP[lower] ?? type;
}
