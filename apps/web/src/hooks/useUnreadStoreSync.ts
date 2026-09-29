// useUnreadStoreSync — unreadStore 的 SSE 接线（#413）：channel.message_sent → store action。
// 引用计数单例（同 useDataPlaneSync ①）：useChannelList 的多个消费方（ChannelHomeRedirect /
// ChannelRail）同时挂载不放大订阅、不双重计数；首个挂载注册、最后一个卸载退订。
// 无轮询/无重连强刷：未读是纯 SSE 实时面，事件处理逻辑唯一一份在 unreadStore.applyMessageSent。
// 2026-09-25 断点修复：挂 onReconnect（决策 9 既有机制）——断线期间错过的事件由
// unreadStore.resyncOnReconnect 拉 REST 最新一页补底数，不再「错过即丢」。
import { useEffect, useRef } from 'react';
import { useWebSocketContext, type WebSocketMessage } from '../api/websocketHooks';
import { useUnreadStore } from '../stores/unreadStore';

function handleUnreadEvent(msg: WebSocketMessage) {
  if (msg.event_type !== 'channel.message_sent') return;
  const data = msg.data as { channelId?: string; message?: { authorType?: string; createdAt?: string } } | null;
  if (!data?.channelId) return;
  const at = data.message?.createdAt ? Date.parse(data.message.createdAt) : undefined;
  useUnreadStore.getState().applyMessageSent(
    data.channelId,
    data.message?.authorType,
    at !== undefined && !Number.isNaN(at) ? at : undefined,
  );
}

let syncRefCount = 0;
let detachEvent: (() => void) | null = null;
let detachReconnect: (() => void) | null = null;

export function useUnreadStoreSync(): void {
  const { onEvent, onReconnect } = useWebSocketContext();
  const onEventRef = useRef(onEvent);
  const onReconnectRef = useRef(onReconnect);
  useEffect(() => {
    onEventRef.current = onEvent;
    onReconnectRef.current = onReconnect;
  });

  // 引用计数单例：重复挂载不放大订阅（provider 的 onEvent/onReconnect 引用稳定）
  useEffect(() => {
    syncRefCount += 1;
    if (syncRefCount === 1) {
      detachEvent = onEventRef.current(handleUnreadEvent);
      // onReconnect 在 context 契约上必填，但部分既有测试 mock 未提供——防御性可选调用
      detachReconnect = onReconnectRef.current?.(() => {
        void useUnreadStore.getState().resyncOnReconnect();
      }) ?? null;
    }
    return () => {
      syncRefCount -= 1;
      if (syncRefCount === 0) {
        detachEvent?.();
        detachEvent = null;
        detachReconnect?.();
        detachReconnect = null;
      }
    };
    // handleUnreadEvent / resyncOnReconnect 引用稳定（模块级/store action），挂载期不重注册
  }, []);
}
