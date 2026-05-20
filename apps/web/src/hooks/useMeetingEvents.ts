/**
 * 会议事件订阅 Hook
 * 
 * 功能：
 * - 连接 WebSocket
 * - 订阅会议事件
 * - 自动重连
 */

import { useEffect, useRef, useCallback } from 'react';

export interface MeetingEvent {
  event_id: string;
  event_type: string;
  timestamp: string;
  data: {
    meetingId: string;
    [key: string]: any;
  };
}

export type MeetingEventHandler = (event: MeetingEvent) => void;

interface UseMeetingEventsOptions {
  meetingId: string | undefined;
  onMessage?: MeetingEventHandler;
  onParticipantJoin?: MeetingEventHandler;
  onParticipantLeave?: MeetingEventHandler;
  onStatusChange?: MeetingEventHandler;
  enabled?: boolean;
}

export function useMeetingEvents({
  meetingId,
  onMessage,
  onParticipantJoin,
  onParticipantLeave,
  onStatusChange,
  enabled = true,
}: UseMeetingEventsOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handlersRef = useRef({
    onMessage,
    onParticipantJoin,
    onParticipantLeave,
    onStatusChange,
  });

  // 更新 handlers
  useEffect(() => {
    handlersRef.current = {
      onMessage,
      onParticipantJoin,
      onParticipantLeave,
      onStatusChange,
    };
  }, [onMessage, onParticipantJoin, onParticipantLeave, onStatusChange]);

  const connect = useCallback(() => {
    if (!meetingId || !enabled) return;

    const wsUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('[WebSocket] Connected');
      // 订阅会议事件
      ws.send(JSON.stringify({
        type: 'subscribe',
        executionId: `meeting:${meetingId}`,
      }));
      ws.send(JSON.stringify({
        type: 'subscribe',
        executionId: 'meetings',
      }));
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as MeetingEvent;
        const { event_type } = data;

        // 分发事件到对应处理器
        switch (event_type) {
          case 'meeting.message_sent':
            handlersRef.current.onMessage?.(data);
            break;
          case 'meeting.participant_joined':
            handlersRef.current.onParticipantJoin?.(data);
            break;
          case 'meeting.participant_left':
            handlersRef.current.onParticipantLeave?.(data);
            break;
          case 'meeting.started':
          case 'meeting.ended':
          case 'meeting.status_changed':
            handlersRef.current.onStatusChange?.(data);
            break;
        }
      } catch (err) {
        console.error('[WebSocket] Parse error:', err);
      }
    };

    ws.onerror = (error) => {
      console.error('[WebSocket] Error:', error);
    };

    ws.onclose = () => {
      console.log('[WebSocket] Disconnected');
      // 5秒后重连
      reconnectTimeoutRef.current = setTimeout(() => {
        console.log('[WebSocket] Reconnecting...');
        connect();
      }, 5000);
    };
  }, [meetingId, enabled]);

  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [connect]);

  return {
    isConnected: wsRef.current?.readyState === WebSocket.OPEN,
  };
}
