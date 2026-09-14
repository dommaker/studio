// useMessageNav — 消息级键盘导航（channel 上下游优化 Phase 3 AC5，
// docs/plans/2026-09-channel-upstream-downstream-ux.md）：
// j 下一条 / k 上一条（维护 focusedId，页面挂 .mc-msg-focused 焦点环）、r 对焦点消息起回复、
// Esc 优先取消 replyTo 其次清焦点。
// 守卫：事件目标是 input/textarea/contenteditable 时 j/k/r 不响应（不劫持文本输入；与
// useGlobalShortcuts 的 isEditableTarget 同口径）；Esc 不受此限——输入框聚焦时仍要生效取消 replyTo。
// mention 弹框开时 Esc 已被 ChannelInput 消费（preventDefault）→ 经 e.defaultPrevented 跳过不抢。
// 滚动跟随不在本 hook：焦点变化经 onFocusScroll 回调交页面（virtualizer.scrollToIndex 优先，DOM 兜底）。
import { useEffect, useRef, useState } from 'react';

export interface UseMessageNavOptions {
  /** 当前可导航消息 id 有序列表（navigableIdsOf(streamView.items)） */
  navIds: string[];
  /** r：对焦点消息起回复（页面复用 handleReply 链路并聚焦输入框） */
  onReply: (messageId: string) => void;
  /** Esc 第一优先判定输入：是否有进行中的回复预览 */
  hasReplyTo: boolean;
  /** Esc 第一优先动作：取消回复预览 */
  onCancelReply: () => void;
  /** 焦点迁移后的滚动跟随（页面持有 virtualizer/DOM 查询） */
  onFocusScroll: (messageId: string) => void;
}

function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
}

export function useMessageNav(options: UseMessageNavOptions): { focusedId: string | null } {
  const [focusedId, setFocusedId] = useState<string | null>(null);
  // 镜像 ref（同 useGlobalShortcuts 模式）：listener 挂一次不随渲染重挂；ref 写入放 effect 避 render 期写 ref 警告
  const ref = useRef({ ...options, focusedId });
  useEffect(() => {
    ref.current = { ...options, focusedId };
  });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const { navIds, onReply, hasReplyTo, onCancelReply, focusedId: cur } = ref.current;
      if (e.key === 'Escape') {
        if (e.defaultPrevented) return; // mention 弹框已消费，不抢
        if (hasReplyTo) {
          onCancelReply();
          return;
        }
        if (cur) setFocusedId(null);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return; // 组合键不劫持（⌘K 等）
      if (isEditableTarget(e.target)) return; // 输入中不导航
      if (navIds.length === 0) return;
      const idx = cur ? navIds.indexOf(cur) : -1;
      if (e.key === 'j') {
        e.preventDefault();
        setFocusedId(idx < 0 ? navIds[0] : navIds[Math.min(idx + 1, navIds.length - 1)]);
      } else if (e.key === 'k') {
        e.preventDefault();
        setFocusedId(idx < 0 ? navIds[navIds.length - 1] : navIds[Math.max(idx - 1, 0)]);
      } else if (e.key === 'r') {
        if (!cur || idx < 0) return; // 无焦点/焦点掉出当前列表 → 不起回复
        e.preventDefault();
        onReply(cur);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  // navIds 变化后焦点可能掉出列表（消息被折叠/删除）→ 有效焦点为派生值，不另存状态
  const effectiveFocusedId = focusedId && options.navIds.includes(focusedId) ? focusedId : null;

  // 焦点迁移滚动跟随（含焦点掉出列表后重新 j/k 的情形）
  useEffect(() => {
    if (effectiveFocusedId) ref.current.onFocusScroll(effectiveFocusedId);
  }, [effectiveFocusedId]);

  return { focusedId: effectiveFocusedId };
}
