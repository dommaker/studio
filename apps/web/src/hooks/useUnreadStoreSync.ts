// useUnreadStoreSync — unreadStore 的 SSE 接线（#413）：channel.message_sent → store action。
// 引用计数单例（同 useDataPlaneSync ①）：useChannelList 的多个消费方（ChannelHomeRedirect /
// ChannelRail）同时挂载不放大订阅、不双重计数；首个挂载注册、最后一个卸载退订。
// 无轮询/无重连强刷：未读是纯 SSE 实时面（无 REST 底数，断线期间事件错过即错过，与原 hook
// 实例 state 行为一致），事件处理逻辑唯一一份在 unreadStore.applyMessageSent。
import { useEffect, useRef } from 'react';
import { useWebSocketContext, type WebSocketMessage } from '../api/websocketHooks';
import { useUnreadStore } from '../stores/unreadStore';

function handleUnreadEvent(msg: WebSocketMessage) {
  if (msg.event_type !== 'channel.message_sent') return;
  const data = msg.data as { channelId?: string; message?: { authorType?: string } } | null;
  if (!data?.channelId) return;
  useUnreadStore.getState().applyMessageSent(data.channelId, data.message?.authorType);
}

let syncRefCount = 0;
let detachEvent: (() => void) | null = null;

export function useUnreadStoreSync(): void {
  const { onEvent } = useWebSocketContext();
  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  });

  // 引用计数单例：重复挂载不放大订阅（provider 的 onEvent 引用稳定）
  useEffect(() => {
    syncRefCount += 1;
    if (syncRefCount === 1) {
      detachEvent = onEventRef.current(handleUnreadEvent);
    }
    return () => {
      syncRefCount -= 1;
      if (syncRefCount === 0 && detachEvent) {
        detachEvent();
        detachEvent = null;
      }
    };
    // handleUnreadEvent / onEvent 引用稳定（模块级），挂载期不重注册
  }, []);
}
