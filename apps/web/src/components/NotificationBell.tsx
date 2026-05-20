// Notification Bell — B2-003: 通知中心
import { useState, useCallback, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWebSocketContext } from '../api/websocket';

interface Notification {
  id: string;
  channelId: string;
  channelName?: string;
  agentName: string;
  content: string;
  time: string;
  read: boolean;
}

export function NotificationBell() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);
  const { onEvent } = useWebSocketContext();
  const dropdownRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const unread = notifications.filter(n => !n.read).length;

  // Listen for @human messages via SSE
  useEffect(() => {
    let flashTimer: ReturnType<typeof setInterval> | null = null;
    const originalTitle = document.title;

    const unsub = onEvent((msg) => {
      if (msg.event_type === 'channel.message_sent') {
        const data = msg.data as any;
        if (data?.message?.meta?.atHuman) {
          const m = data.message;
          setNotifications(prev => [{
            id: m.id || msg.event_id,
            channelId: data.channelId,
            agentName: m.agentName || 'Agent',
            content: m.content.slice(0, 80),
            time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
            read: false,
          }, ...prev.slice(0, 49)]);

          // B2-004: Title flash for @human
          let on = true;
          flashTimer = setInterval(() => {
            document.title = on ? `🔴 @${m.agentName || 'Agent'} 需要你 - Agent Studio` : originalTitle;
            on = !on;
          }, 1000);
          setTimeout(() => {
            if (flashTimer) { clearInterval(flashTimer); flashTimer = null; }
            document.title = originalTitle;
          }, 10000);
        }
      }
    });
    return () => {
      unsub();
      if (flashTimer) clearInterval(flashTimer);
      document.title = originalTitle;
    };
  }, [onEvent]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const markAllRead = useCallback(() => {
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
  }, []);

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setOpen(!open)}
        className="relative p-1.5 rounded-lg hover:bg-gray-100 transition-colors"
        title="通知中心"
      >
        <span className="text-lg">🔔</span>
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 bg-red-500 text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 bg-white border border-gray-200 rounded-lg shadow-xl z-50">
          <div className="flex items-center justify-between px-4 py-2 border-b border-gray-100">
            <span className="text-sm font-semibold text-gray-700">通知</span>
            {unread > 0 && (
              <button onClick={markAllRead} className="text-xs text-blue-500 hover:underline">
                全部已读
              </button>
            )}
          </div>

          <div className="max-h-80 overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="px-4 py-8 text-center text-xs text-gray-400">暂无通知</div>
            ) : (
              notifications.map(n => (
                <button
                  key={n.id}
                  onClick={() => {
                    setNotifications(prev => prev.map(x => x.id === n.id ? { ...x, read: true } : x));
                    navigate(`/channels/${n.channelId}`);
                    setOpen(false);
                  }}
                  className={`w-full text-left px-4 py-2.5 border-b border-gray-50 hover:bg-gray-50 transition-colors ${
                    !n.read ? 'bg-blue-50/50' : ''
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {!n.read && <span className="w-1.5 h-1.5 bg-blue-500 rounded-full flex-shrink-0" />}
                    <span className="text-xs font-medium text-gray-700">@{n.agentName}</span>
                    <span className="text-[10px] text-gray-400 ml-auto">{n.time}</span>
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5 truncate">{n.content}</p>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
