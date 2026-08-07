// WorkUnit 事件订阅 — workunit.created / workunit.status_changed / workunit.execution.step（SSE）
// 列表/抽屉据此实时刷新，替代纯 REST 手动刷新；回调防抖合并事件风暴
// （execution.step 在执行期每步一条，防抖后触发详情重拉 = 过程视图近实时）
import { useEffect, useRef } from 'react';
import { useWebSocketContext } from '../api/websocketHooks';

const WORKUNIT_EVENT_TYPES = new Set(['workunit.created', 'workunit.status_changed', 'workunit.execution.step']);

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
