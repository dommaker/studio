/**
 * assigneeId 双语义批量解析器（语义权威：apps/api/src/modules/workunit/CONTEXT.md「assigneeId 双语义」条）。
 *
 * assigneeId 两种形态：
 *   - 认领后 = 实例 id（需经 state.roleId 反查 profile id）
 *   - 未认领指名（@mention/委派，§1.2-b）= profile id 本身（直通）
 *
 * 此前各消费方自建 instance→profile map 且口径不一（metrics 缺 profile-id 直通，
 * 未认领指名 WU 静默归因为 null）。本模块收敛为：一次建 map + 双形态解析。
 *
 * 单 WU 变体见 agents/loop/review-dispatcher.ts resolveProfileId（按 getProfile → getState
 * 逐个查询，语义相同；如需单点解析可基于本模块包一层）。
 *
 * 零依赖叶子：仅 type 引用 studio-shared，禁止引入本模块外的运行时依赖（防循环）。
 */

/** assigneeId → profileId 解析函数；无法解析（空/未知 id）返回 null，不编造 */
export type AssigneeProfileResolver = (assigneeId: string | null | undefined) => string | null;

export interface AssigneeProfileResolverInput {
  /** 实例 state 列表（FileStore.listStates 口径；只需 id/roleId） */
  states: Array<{ id?: string | null; roleId?: string | null }>;
  /** 已知 profile id 集合（FileStore.listProfiles 的 id；未认领指名形态直通判据） */
  profileIds: ReadonlySet<string>;
}

/**
 * 一次构建 instance→profile map，返回双形态解析函数：
 *   1. assigneeId 命中实例 map → state.roleId（profile id）
 *   2. 否则命中 profileIds → 原样直通（未认领指名形态）
 *   3. 否则（含 null/undefined/空串）→ null
 */
export function buildAssigneeProfileResolver(input: AssigneeProfileResolverInput): AssigneeProfileResolver {
  const instanceToProfile = new Map<string, string>();
  for (const s of input.states) {
    if (s?.id && s?.roleId) instanceToProfile.set(s.id, s.roleId);
  }
  const profileIds = input.profileIds;
  return (assigneeId) => {
    if (!assigneeId) return null;
    return instanceToProfile.get(assigneeId) ?? (profileIds.has(assigneeId) ? assigneeId : null);
  };
}
