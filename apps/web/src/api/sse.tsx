// SSE 客户端（EventSource）— 根部单连接 Provider + hooks
// 组件门面：类型 / useSse / context / useSseContext 已拆至 ./sseHooks
import { useRef, useCallback } from 'react';
import type { ReactNode } from 'react';
import { useSse, SseContext, type SseMessage } from './sseHooks';

export type { SseMessage, SseStatus } from './sseHooks';

export function SseProvider({ children }: { children: ReactNode }) {
  const handlersRef = useRef<Set<(msg: SseMessage) => void>>(new Set());
  const reconnectHandlersRef = useRef<Set<() => void>>(new Set());

  const onMessage = useCallback((msg: SseMessage) => {
    handlersRef.current.forEach(h => h(msg));
  }, []);

  const onEvent = useCallback((handler: (msg: SseMessage) => void) => {
    handlersRef.current.add(handler);
    return () => { handlersRef.current.delete(handler); };
  }, []);

  // 决策 9（2026-08 SSE 负载加深）：断线重连（onopen 且非首次）→ 广播给注册方做一次性 refetch
  const handleReconnect = useCallback(() => {
    reconnectHandlersRef.current.forEach(h => h());
  }, []);

  const onReconnect = useCallback((handler: () => void) => {
    reconnectHandlersRef.current.add(handler);
    return () => { reconnectHandlersRef.current.delete(handler); };
  }, []);

  const sse = useSse({ onMessage, onReconnect: handleReconnect });

  return (
    <SseContext.Provider value={{ ...sse, onEvent, onReconnect }}>
      {children}
    </SseContext.Provider>
  );
}
