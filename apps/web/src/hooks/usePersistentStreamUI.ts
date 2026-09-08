// 频道折叠 UI 状态按频道持久化（docs/plans/2026-09-ui-smoothness.md Step 3）：
// showCompleted / collapsedThreads / expandedProcGroups 三项按频道存 localStorage
//（key `mc-stream-ui:v1:<channelId>`，值 JSON，Set ↔ 数组序列化），切频道/刷新后恢复；
// 读取损坏/缺字段静默回退默认值；写入随状态变更直写（量级小，不防抖）。
// setter 语义与 React useState 的 Dispatch<SetStateAction<T>> 对齐，页面调用方零改造迁移。
import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';

const KEY_PREFIX = 'mc-stream-ui:v1:';

/** 持久化形态（localStorage JSON）：Set 序列化为数组 */
interface PersistedStreamUi {
  showCompleted: boolean;
  collapsedThreads: string[];
  expandedProcGroups: string[];
}

const DEFAULTS: PersistedStreamUi = { showCompleted: false, collapsedThreads: [], expandedProcGroups: [] };

/** 读取持久化状态；损坏 JSON 整体回退默认值，缺字段按字段回退（非字符串条目丢弃） */
function readPersisted(channelId: string): PersistedStreamUi {
  try {
    const raw = window.localStorage.getItem(KEY_PREFIX + channelId);
    if (!raw) return DEFAULTS;
    const p: unknown = JSON.parse(raw);
    if (!p || typeof p !== 'object') return DEFAULTS;
    const rec = p as Record<string, unknown>;
    const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    return {
      showCompleted: rec.showCompleted === true,
      collapsedThreads: strArr(rec.collapsedThreads),
      expandedProcGroups: strArr(rec.expandedProcGroups),
    };
  } catch {
    return DEFAULTS;
  }
}

interface StreamUiStateShape {
  /** 所属频道 id（切换频道时经渲染期 state 调整加载新频道存档） */
  channelId: string | undefined;
  showCompleted: boolean;
  collapsedThreads: Set<string>;
  expandedProcGroups: Set<string>;
}

const loadState = (channelId: string | undefined): StreamUiStateShape => {
  const p = channelId ? readPersisted(channelId) : DEFAULTS;
  return {
    channelId,
    showCompleted: p.showCompleted,
    collapsedThreads: new Set(p.collapsedThreads),
    expandedProcGroups: new Set(p.expandedProcGroups),
  };
};

const resolve = <T>(v: SetStateAction<T>, prev: T): T =>
  (typeof v === 'function' ? (v as (p: T) => T)(prev) : v);

export function usePersistentStreamUI(channelId: string | undefined) {
  const [state, setState] = useState<StreamUiStateShape>(() => loadState(channelId));
  // 频道切换：加载对应频道存档（渲染期调整 state——切换当帧即生效，不带旧频道状态闪一帧）
  if (state.channelId !== channelId) setState(loadState(channelId));

  // 状态变更即直写持久化（存储不可用静默降级：仅丢持久化，不影响交互）
  useEffect(() => {
    if (!channelId) return;
    try {
      window.localStorage.setItem(KEY_PREFIX + channelId, JSON.stringify({
        showCompleted: state.showCompleted,
        collapsedThreads: [...state.collapsedThreads],
        expandedProcGroups: [...state.expandedProcGroups],
      }));
    } catch { /* 存储不可用静默降级 */ }
  }, [channelId, state]);

  // setter 引用稳定（空依赖 useCallback）——页面 useCallback/useMemo 依赖链不因此失效
  const setShowCompleted = useCallback<Dispatch<SetStateAction<boolean>>>(
    v => setState(prev => ({ ...prev, showCompleted: resolve(v, prev.showCompleted) })), []);
  const setCollapsedThreads = useCallback<Dispatch<SetStateAction<Set<string>>>>(
    v => setState(prev => ({ ...prev, collapsedThreads: resolve(v, prev.collapsedThreads) })), []);
  const setExpandedProcGroups = useCallback<Dispatch<SetStateAction<Set<string>>>>(
    v => setState(prev => ({ ...prev, expandedProcGroups: resolve(v, prev.expandedProcGroups) })), []);

  return {
    showCompleted: state.showCompleted,
    collapsedThreads: state.collapsedThreads,
    expandedProcGroups: state.expandedProcGroups,
    setShowCompleted,
    setCollapsedThreads,
    setExpandedProcGroups,
  };
}
