// SSE 客户端 hooks — 从 websocket.tsx 拆出（类型 / useWebSocket / context / useWebSocketContext），
// 使 websocket.tsx 只保留 WebSocketProvider 组件导出
import { useState, useRef, useEffect, createContext, useContext, useCallback } from 'react';
import { useAuthStore } from '../stores/authStore';

/**
 * 构建 SSE URL（每次连接时现取 token，登录/登出后重连即生效）。
 * 2026-08-25：/events/stream 已移出 PUBLIC_API，需 ?token= 携带 JWT
 * （EventSource 无法设置 Authorization 头）。
 */
function buildSseUrl(): string {
  const apiUrl = import.meta.env.VITE_API_URL || '/api/v1';
  const base = apiUrl.startsWith('http') ? apiUrl : `${window.location.origin}${apiUrl}`;
  const token = useAuthStore.getState().token;
  return token ? `${base}/events/stream?token=${encodeURIComponent(token)}` : `${base}/events/stream`;
}

export interface WebSocketMessage {
  event_id: string;
  event_type: string;
  timestamp: string;
  data: unknown;
}

export type WebSocketStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

interface UseSSEOptions {
  url?: string;
  onMessage?: (message: WebSocketMessage) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Event) => void;
  /** 决策 9（2026-08 SSE 负载加深）：断线重连（onopen 且非首次连接）时触发，供消费侧一次性 refetch */
  onReconnect?: () => void;
  reconnect?: boolean;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
}

export function useWebSocket(options: UseSSEOptions = {}) {
  const {
    onMessage,
    onConnect,
    onDisconnect,
    onError,
    onReconnect,
    reconnect = true,
    reconnectInterval = 3000,
    maxReconnectAttempts = 5,
  } = options;

  const [status, setStatus] = useState<WebSocketStatus>('disconnected');
  const esRef = useRef<EventSource | null>(null);
  const reconnectAttempts = useRef(0);
  const reconnectTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 首次 onopen 不算重连；之后每次 onopen（EventSource 内建自动重连成功）触发 onReconnect
  const hasOpenedRef = useRef(false);

  // Stabilize callbacks with refs to avoid SSE reconnect loop
  const callbacksRef = useRef({ onMessage, onConnect, onDisconnect, onError, onReconnect });
  useEffect(() => {
    callbacksRef.current = { onMessage, onConnect, onDisconnect, onError, onReconnect };
  });

  const disconnect = useCallback(() => {
    if (reconnectTimeout.current) clearTimeout(reconnectTimeout.current);
    esRef.current?.close();
    esRef.current = null;
    setStatus('disconnected');
  }, []);

  const connect = useCallback(() => {
    if (esRef.current) return;
    setStatus('connecting');

    const es = new EventSource(buildSseUrl());
    esRef.current = es;

    es.onopen = () => {
      setStatus('connected');
      reconnectAttempts.current = 0;
      callbacksRef.current.onConnect?.();
      // 决策 9：非首次 onopen = 断线重连成功 → 触发一次性 refetch 回调
      if (hasOpenedRef.current) callbacksRef.current.onReconnect?.();
      hasOpenedRef.current = true;
    };

    es.onmessage = (event) => {
      try {
        const message: WebSocketMessage = JSON.parse(event.data);
        callbacksRef.current.onMessage?.(message);
      } catch {
        // SSE heartbeat comments are not JSON, skip silently
      }
    };

    es.onerror = () => {
      // EventSource has built-in auto-reconnect. Don't manually reconnect.
      if (es.readyState === EventSource.CLOSED) {
        setStatus('disconnected');
        callbacksRef.current.onDisconnect?.();
        esRef.current = null;
        // Let EventSource handle its own reconnection
      } else if (es.readyState === EventSource.CONNECTING) {
        setStatus('connecting');
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconnect, reconnectInterval, maxReconnectAttempts]);

  useEffect(() => {
    connect();
    return () => disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // stable: callbacks live in ref, connect/disconnect are stable

  return { status, disconnect, connect };
}

// ── React Context ──

interface WebSocketContextValue {
  status: WebSocketStatus;
  disconnect: () => void;
  connect: () => void;
  /** B2: 注册 SSE 事件监听器，返回取消注册函数 */
  onEvent: (handler: (msg: WebSocketMessage) => void) => () => void;
  /** 决策 9：注册 SSE 断线重连监听器（首次连接不触发），返回取消注册函数 */
  onReconnect: (handler: () => void) => () => void;
}

export const WebSocketContext = createContext<WebSocketContextValue | null>(null);

export function useWebSocketContext() {
  const ctx = useContext(WebSocketContext);
  if (!ctx) throw new Error('useWebSocketContext must be used within WebSocketProvider');
  return ctx;
}
