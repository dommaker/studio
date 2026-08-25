// SSE 客户端 — 替代 WebSocket（2026-05-08）
// 组件门面：类型 / useWebSocket / context / useWebSocketContext 已拆至 ./websocketHooks
import { useRef, useCallback } from 'react';
import type { ReactNode } from 'react';
import { useWebSocket, WebSocketContext, type WebSocketMessage } from './websocketHooks';

export type { WebSocketMessage, WebSocketStatus } from './websocketHooks';

export function WebSocketProvider({ children }: { children: ReactNode }) {
  const handlersRef = useRef<Set<(msg: WebSocketMessage) => void>>(new Set());
  const reconnectHandlersRef = useRef<Set<() => void>>(new Set());

  const onMessage = useCallback((msg: WebSocketMessage) => {
    handlersRef.current.forEach(h => h(msg));
  }, []);

  const onEvent = useCallback((handler: (msg: WebSocketMessage) => void) => {
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

  const ws = useWebSocket({ onMessage, onReconnect: handleReconnect });

  return (
    <WebSocketContext.Provider value={{ ...ws, onEvent, onReconnect }}>
      {children}
    </WebSocketContext.Provider>
  );
}
