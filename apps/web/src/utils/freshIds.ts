// freshIds — 新内容进场渐隐高亮（批次 E-3）的核心机制唯一一份（#549，B5 收口）：
// id 集 + per-id 2s 自清计时。此前同一 UX 两份手写实现（WU 行 per-id timer /
// 频道消息单 timer 全清），语义统一为 per-id：各自到达起 2s 渐隐，互不重计时。
// 消费方：workunitStore（created 事件路由驱动 mark，WU 行 .wu-row-new）与
// useFreshMessageIds（频道消息 .mc-msg-new）。纯件非 hook——store 侧模块级单例、
// hook 侧实例随组件生命周期 dispose。
export const FRESH_FADE_MS = 2000;

export interface FreshIdTracker {
  /** 标记 id 进场（已在集 = 计时重置，不重复通知）；2s 后自清并经 onChange 广播新快照 */
  mark: (id: string) => void;
  /** 清全部计时器（组件卸载 / 测试重置）；之后不再触发 onChange */
  dispose: () => void;
}

export function createFreshIdTracker(onChange: (ids: ReadonlySet<string>) => void): FreshIdTracker {
  const ids = new Set<string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  return {
    mark(id) {
      const isNew = !ids.has(id);
      ids.add(id);
      const prev = timers.get(id);
      if (prev) clearTimeout(prev);
      timers.set(id, setTimeout(() => {
        timers.delete(id);
        ids.delete(id);
        onChange(new Set(ids));
      }, FRESH_FADE_MS));
      if (isNew) onChange(new Set(ids));
    },
    dispose() {
      timers.forEach(clearTimeout);
      timers.clear();
      ids.clear();
    },
  };
}
