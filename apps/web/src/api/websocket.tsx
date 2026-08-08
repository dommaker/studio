// SSE 客户端 — 替代 WebSocket（2026-05-08）
// 组件门面：类型 / useWebSocket / context / useWebSocketContext 已拆至 ./websocketHooks
import { useRef, useCallback } from 'react';
import type { ReactNode } from 'react';
import { useWebSocket, WebSocketContext, type WebSocketMessage } from './websocketHooks';

export type { WebSocketMessage, WebSocketStatus } from './websocketHooks';

export function WebSocketProvider({ children }: { children: ReactNode }) {
  const handlersRef = useRef<Set<(msg: WebSocketMessage) => void>>(new Set());

  const onMessage = useCallback((msg: WebSocketMessage) => {
    handlersRef.current.forEach(h => h(msg));
  }, []);

  const onEvent = useCallback((handler: (msg: WebSocketMessage) => void) => {
    handlersRef.current.add(handler);
    return () => { handlersRef.current.delete(handler); };
  }, []);

  const ws = useWebSocket({ onMessage });

  return (
    <WebSocketContext.Provider value={{ ...ws, onEvent }}>
      {children}
    </WebSocketContext.Provider>
  );
}
