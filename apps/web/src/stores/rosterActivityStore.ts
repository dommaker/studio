// 作战视图执行动态 store（#348 状态下沉）：workunit.execution.step/stream 的 chunk 写入此处，
// RoleCard 经 useRosterActivities 只订自己 roleId 的切片——chunk 只重渲对应卡，
// 不再掀 AgentDashboardPage 整树（对齐 ChannelLiveBars #322 状态下沉先例）。
// 生命周期 = 页面挂载期：useAgentRoster 卸载时 reset（动态是页面私有实时面，每次进页从零开始）。
import { create } from 'zustand';

/** 卡片「最近动态」条目（SSE 实时追加，内存每 agent 最多保留 MAX_ACTIVITIES 条） */
export interface RosterActivityItem {
  /** 去重键：相同键的新条目替换旧条目（流式 thinking/text 逐 chunk 刷新同一行） */
  key?: string;
  at: string;
  text: string;
}

export const MAX_ACTIVITIES = 10;

/** 追加动态：同 key 替换尾条（流式 chunk 刷新同一行），超出上限丢最旧 */
export function pushActivity(list: RosterActivityItem[], item: RosterActivityItem): RosterActivityItem[] {
  const last = list[list.length - 1];
  const next = last?.key && last.key === item.key ? [...list.slice(0, -1), item] : [...list, item];
  return next.length > MAX_ACTIVITIES ? next.slice(next.length - MAX_ACTIVITIES) : next;
}

interface RosterActivityState {
  /** roleId → 动态列表（按时间升序，末尾最新） */
  activities: Record<string, RosterActivityItem[]>;
  appendActivity: (roleId: string, item: RosterActivityItem) => void;
  /** 页面卸载即清，防跨挂载残留 */
  resetActivities: () => void;
}

export const useRosterActivityStore = create<RosterActivityState>((set) => ({
  activities: {},
  appendActivity: (roleId, item) =>
    set((state) => ({
      activities: { ...state.activities, [roleId]: pushActivity(state.activities[roleId] ?? [], item) },
    })),
  resetActivities: () => set({ activities: {} }),
}));

/** 模块级空数组：未落动态的卡订阅返回稳定引用，selector 不被空数组字面量打破 */
const EMPTY: RosterActivityItem[] = [];

/** 卡片级订阅：他卡 chunk 改写 activities 记录但本卡切片引用不变 → 静态卡壳零重渲 */
export function useRosterActivities(roleId: string): RosterActivityItem[] {
  return useRosterActivityStore((s) => s.activities[roleId] ?? EMPTY);
}
