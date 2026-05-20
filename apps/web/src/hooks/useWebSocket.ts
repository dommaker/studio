// WebSocket 连接管理 Hook（P2-4）
// 支持自动重连、心跳检测、连接状态管理

import { useEffect, useRef, useState, useCallback } from 'react';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

interface UseWebSocketOptions {
  url: string;
  onMessage?: (data: any) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  reconnectAttempts?: number;
  reconnectInterval?: number;
  heartbeatInterval?: number;
}

interface UseWebSocketReturn {
  state: ConnectionState;
  send: (data: any) => void;
  subscribe: (topic: string) => void;
  unsubscribe: (topic: string) => void;
  reconnect: () => void;
}

export function useWebSocket(options: UseWebSocketOptions): UseWebSocketReturn {
  const {
    url,
    onMessage,
    onConnect,
    onDisconnect,
    reconnectAttempts = 5,
    reconnectInterval = 3000,
    heartbeatInterval = 30000,
  } = options;

  const [state, setState] = useState<ConnectionState>('connecting');
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectCountRef = useRef(0);
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const subscriptionsRef = useRef<Set<string>>(new Set());

  // 清理定时器
  const clearTimers = useCallback(() => {
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  // 开始心跳
  const startHeartbeat = useCallback(() => {
    clearTimers();
    
    heartbeatTimerRef.current = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'ping' }));
      }
    }, heartbeatInterval);
  }, [heartbeatInterval, clearTimers]);

  // 连接 WebSocket
  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    setState('connecting');

    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setState('connected');
        reconnectCountRef.current = 0;

        // 重新订阅之前的主题
        subscriptionsRef.current.forEach((topic) => {
          ws.send(JSON.stringify({ type: 'subscribe', executionId: topic }));
        });

        // 启动心跳
        startHeartbeat();

        onConnect?.();
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          
          // 忽略 pong 消息
          if (data.type === 'pong') {
            return;
          }

          onMessage?.(data);
        } catch (err) {
          console.error('Failed to parse WebSocket message:', err);
        }
      };

      ws.onclose = () => {
        clearTimers();
        setState('disconnected');
        onDisconnect?.();

        // 自动重连
        if (reconnectCountRef.current < reconnectAttempts) {
          setState('reconnecting');
          reconnectTimerRef.current = setTimeout(() => {
            reconnectCountRef.current++;
            connect();
          }, reconnectInterval);
        }
      };

      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
      };
    } catch (err) {
      console.error('Failed to connect WebSocket:', err);
      setState('disconnected');
    }
  }, [url, reconnectAttempts, reconnectInterval, startHeartbeat, clearTimers, onConnect, onDisconnect, onMessage]);

  // 发送消息
  const send = useCallback((data: any) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    } else {
      console.warn('WebSocket is not connected');
    }
  }, []);

  // 订阅主题
  const subscribe = useCallback((topic: string) => {
    subscriptionsRef.current.add(topic);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'subscribe', executionId: topic }));
    }
  }, []);

  // 取消订阅
  const unsubscribe = useCallback((topic: string) => {
    subscriptionsRef.current.delete(topic);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'unsubscribe', executionId: topic }));
    }
  }, []);

  // 手动重连
  const reconnect = useCallback(() => {
    reconnectCountRef.current = 0;
    clearTimers();
    
    if (wsRef.current) {
      wsRef.current.close();
    }
    
    connect();
  }, [connect, clearTimers]);

  // 初始化连接
  useEffect(() => {
    connect();

    return () => {
      clearTimers();
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [connect, clearTimers]);

  return {
    state,
    send,
    subscribe,
    unsubscribe,
    reconnect,
  };
}
