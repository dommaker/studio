// WorkUnit 事件订阅 — workunit.created / workunit.status_changed（SSE）
// 列表/抽屉据此实时刷新，替代纯 REST 手动刷新；回调防抖合并事件风暴
import { useEffect, useRef } from 'react';
import { useWebSocketContext } from '../api/websocket';

const WORKUNIT_EVENT_TYPES = new Set(['workunit.created', 'workunit.status_changed']);

export function useWorkUnitEvents(onChange: () => void, debounceMs = 400) {
  const { onEvent } = useWebSocketContext();
  const cbRef = useRef(onChange);
  cbRef.current = onChange;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = onEvent((msg) => {
      if (!WORKUNIT_EVENT_TYPES.has(msg.event_type)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => cbRef.current(), debounceMs);
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [onEvent, debounceMs]);
}
