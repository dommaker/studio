// SSE 客户端 hooks — 从 sse.tsx 拆出（类型 / useSse / context / useSseContext），
// 使 sse.tsx 只保留 SseProvider 组件导出
import { useState, useRef, useEffect, createContext, useContext, useCallback } from 'react';
import { useAuthStore } from '../stores/authStore';
import { fetchStreamTicket } from '../utils/streamTicket';

/** 长期 JWT 只经 API client 换取单用途票据，不进入 EventSource URL。 */
function buildSseUrl(ticket?: string): string {
  const apiUrl = import.meta.env.VITE_API_URL || '/api/v1';
  const base = apiUrl.startsWith('http') ? apiUrl : `${window.location.origin}${apiUrl}`;
  return ticket ? `${base}/events/stream?token=${encodeURIComponent(ticket)}` : `${base}/events/stream`;
}

// SseMessage/SseStatus：P3-a 迁至 src/types/sse.ts（api 层不声明导出类型），
// 此处仅 re-export，消费方 import 路径不变。
// #690：sseEventSchema 接到 es.onmessage 单点解析（parseSseMessage，运行时件归 ./sseParser）。
import { parseSseMessage } from './sseParser';
import { type SseMessage, type SseStatus } from '../types/sse';
export type { SseMessage, SseStatus };

interface UseSSEOptions {
  url?: string;
  onMessage?: (message: SseMessage) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Event) => void;
  /** 决策 9（2026-08 SSE 负载加深）：断线重连（onopen 且非首次连接）时触发，供消费侧一次性 refetch */
  onReconnect?: () => void;
  reconnect?: boolean;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
}

export function useSse(options: UseSSEOptions = {}) {
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

  const [status, setStatus] = useState<SseStatus>('disconnected');
  const esRef = useRef<EventSource | null>(null);
  const reconnectAttempts = useRef(0);
  const reconnectTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ticketRequest = useRef(0);
  const connectingRef = useRef(false);
  // 首次 onopen 不算重连；之后每次 onopen 触发 onReconnect。
  const hasOpenedRef = useRef(false);

  // Stabilize callbacks with refs to avoid SSE reconnect loop
  const callbacksRef = useRef({ onMessage, onConnect, onDisconnect, onError, onReconnect });
  useEffect(() => {
    callbacksRef.current = { onMessage, onConnect, onDisconnect, onError, onReconnect };
  });

  const disconnect = useCallback(() => {
    ticketRequest.current += 1;
    connectingRef.current = false;
    if (reconnectTimeout.current) clearTimeout(reconnectTimeout.current);
    reconnectTimeout.current = null;
    esRef.current?.close();
    esRef.current = null;
    setStatus('disconnected');
  }, []);

  const connect = useCallback(() => {
    if (esRef.current || connectingRef.current) return;
    connectingRef.current = true;
    setStatus('connecting');
    const requestId = ++ticketRequest.current;
    const token = useAuthStore.getState().token;

    const scheduleReconnect = () => {
      if (!reconnect || reconnectAttempts.current >= maxReconnectAttempts) return;
      reconnectAttempts.current += 1;
      reconnectTimeout.current = setTimeout(() => {
        reconnectTimeout.current = null;
        connect();
      }, reconnectInterval);
    };

    const open = (ticket?: string) => {
      if (requestId !== ticketRequest.current) return;
      connectingRef.current = false;
      const es = new EventSource(buildSseUrl(ticket));
      esRef.current = es;

      es.onopen = () => {
        setStatus('connected');
        reconnectAttempts.current = 0;
        callbacksRef.current.onConnect?.();
        if (hasOpenedRef.current) callbacksRef.current.onReconnect?.();
        hasOpenedRef.current = true;
      };

      es.onmessage = (event) => {
        let raw: unknown;
        try {
          raw = JSON.parse(event.data);
        } catch {
          return;
        }
        const message = parseSseMessage(raw);
        if (message) callbacksRef.current.onMessage?.(message);
      };

      es.onerror = (event) => {
        callbacksRef.current.onError?.(event);
        // 票据已消费，任何失败都必须另取新票；无凭证本地流保留原生重连。
        if (token || es.readyState === EventSource.CLOSED) {
          es.close();
          if (esRef.current === es) esRef.current = null;
          connectingRef.current = false;
          setStatus('disconnected');
          callbacksRef.current.onDisconnect?.();
          scheduleReconnect();
        } else if (es.readyState === EventSource.CONNECTING) {
          setStatus('connecting');
        }
      };
    };

    if (!token) {
      open();
      return;
    }
    void fetchStreamTicket('/api/v1/events/stream').then(open).catch(() => {
      if (requestId !== ticketRequest.current) return;
      connectingRef.current = false;
      setStatus('disconnected');
      scheduleReconnect();
    });
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

interface SseContextValue {
  status: SseStatus;
  disconnect: () => void;
  connect: () => void;
  /** B2: 注册 SSE 事件监听器，返回取消注册函数 */
  onEvent: (handler: (msg: SseMessage) => void) => () => void;
  /** 决策 9：注册 SSE 断线重连监听器（首次连接不触发），返回取消注册函数 */
  onReconnect: (handler: () => void) => () => void;
}

export const SseContext = createContext<SseContextValue | null>(null);

export function useSseContext() {
  const ctx = useContext(SseContext);
  if (!ctx) throw new Error('useSseContext must be used within SseProvider');
  return ctx;
}
