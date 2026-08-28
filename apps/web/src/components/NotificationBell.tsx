// Notification Bell — B2-003 通知中心；#274 接后端 notifications API（JWT 身份）
// 2026-07 §5.7: 通知可点击跳转 —— 本体按 WU > PMO > 频道优先级，另附 WU/PMO 直跳小按钮
// 数据源 = 后端持久化通知（刷新不丢）+ SSE atHuman 实时增量（无后端 id，已读仅本地）
// 列表与已读动作住 stores/notificationStore（读态跨组件共享：频道页进页 markChannelRead）
import { useState, useCallback, useRef, useEffect } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWebSocketContext } from '../api/websocketHooks';
import { useNotificationStore, type Notification } from '../stores/notificationStore';

/** channel.message_sent SSE payload（服务端 shapeMessageData 已把 meta 解析为对象） */
interface ChannelMessageSentData {
  channelId: string;
  message: {
    id: string;
    agentName?: string | null;
    content: string;
    workUnitId?: string | null;
    meta?: {
      atHuman?: boolean;
      pmoId?: string;
    } | null;
  };
}

export function NotificationBell() {
  const notifications = useNotificationStore(s => s.notifications);
  const loadFromBackend = useNotificationStore(s => s.loadFromBackend);
  const pushSse = useNotificationStore(s => s.pushSse);
  const markRead = useNotificationStore(s => s.markRead);
  const markAllRead = useNotificationStore(s => s.markAllRead);
  const [open, setOpen] = useState(false);
  const { onEvent } = useWebSocketContext();
  const dropdownRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const unread = notifications.filter(n => !n.read).length;

  // #274: 挂载时拉后端持久化通知（按当前登录身份过滤，Bearer 由 axios 拦截器注入）
  useEffect(() => {
    void loadFromBackend();
  }, [loadFromBackend]);

  // B2-004 标题闪烁定时器：收进 ref 管理——开新闪前必清旧闪（修：10s 内多条 @human
  // 旧 interval 被覆盖引用导致永久泄漏闪烁）；未读归零/卸载即停（修：全部已读后仍闪到超时）
  const flashIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const flashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTitleRef = useRef<string | null>(null);

  const stopFlash = useCallback(() => {
    if (flashIntervalRef.current) { clearInterval(flashIntervalRef.current); flashIntervalRef.current = null; }
    if (flashTimeoutRef.current) { clearTimeout(flashTimeoutRef.current); flashTimeoutRef.current = null; }
    if (savedTitleRef.current !== null) { document.title = savedTitleRef.current; savedTitleRef.current = null; }
  }, []);

  const startFlash = useCallback((agentName: string) => {
    stopFlash();
    const original = document.title;
    savedTitleRef.current = original;
    let on = true;
    flashIntervalRef.current = setInterval(() => {
      document.title = on ? `🔴 @${agentName} 需要你 - Agent Studio` : original;
      on = !on;
    }, 1000);
    flashTimeoutRef.current = setTimeout(stopFlash, 10000);
  }, [stopFlash]);

  // 未读归零（单条/全部已读）即停闪
  useEffect(() => {
    if (unread === 0) stopFlash();
  }, [unread, stopFlash]);

  // 卸载清闪
  useEffect(() => stopFlash, [stopFlash]);

  // Listen for @human messages via SSE（实时增量，刷新即丢，由后端通知承担持久面）
  useEffect(() => {
    const unsub = onEvent((msg) => {
      if (msg.event_type === 'channel.message_sent') {
        const data = msg.data as ChannelMessageSentData | undefined;
        if (data?.message?.meta?.atHuman) {
          const m = data.message;
          pushSse({
            id: m.id || msg.event_id,
            backendId: null,
            channelId: data.channelId,
            agentName: m.agentName || 'Agent',
            title: null,
            content: m.content.slice(0, 80),
            time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
            read: false,
            workUnitId: m.workUnitId ?? null,
            pmoId: m.meta?.pmoId ?? null,
          });

          // B2-004: Title flash for @human
          startFlash(m.agentName || 'Agent');
        }
      }
    });
    return () => { unsub(); };
  }, [onEvent, startFlash, pushSse]);

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

  // 点通知本体：标记已读（store 动作内含后端同步），跳转优先级 WU 详情 > PMO 详情 > 频道
  const openNotification = useCallback((n: Notification) => {
    markRead(n.id);
    if (n.workUnitId) navigate(`/workunits/${n.workUnitId}`);
    else if (n.pmoId) navigate(`/pmo/project/${n.pmoId}`);
    else if (n.channelId) navigate(`/channels/${n.channelId}`);
    setOpen(false);
  }, [markRead, navigate]);

  // 点 WU/PMO 小按钮：直跳目标，不触发本体跳转
  const openTarget = useCallback((e: ReactMouseEvent, n: Notification, path: string) => {
    e.stopPropagation();
    markRead(n.id);
    navigate(path);
    setOpen(false);
  }, [markRead, navigate]);

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setOpen(!open)}
        className="relative p-1.5 rounded-lg u-hover-bg transition-colors"
        title="通知中心"
      >
        <span className="text-lg">🔔</span>
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 u-err-bg u-on-accent text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 u-surface border u-border rounded-lg shadow-xl z-50">
          <div className="flex items-center justify-between px-4 py-2 border-b u-border">
            <span className="text-sm font-semibold u-text">通知</span>
            {unread > 0 && (
              <button onClick={markAllRead} className="text-xs u-accent hover:underline">
                全部已读
              </button>
            )}
          </div>

          <div className="max-h-80 overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="px-4 py-8 text-center text-xs u-text-3">暂无通知</div>
            ) : (
              notifications.map(n => (
                <div
                  key={n.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => openNotification(n)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      openNotification(n);
                    }
                  }}
                  className={`w-full text-left px-4 py-2.5 border-b u-border u-hover-bg transition-colors cursor-pointer ${
                    !n.read ? 'u-accent-dim' : ''
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {!n.read && <span className="w-1.5 h-1.5 u-accent-bg rounded-full flex-shrink-0" />}
                    <span className="text-xs font-medium u-text">
                      {n.title ? n.title : `@${n.agentName}`}
                    </span>
                    <span className="text-[10px] u-text-3 ml-auto">{n.time}</span>
                    {n.workUnitId && (
                      <button
                        type="button"
                        onClick={e => openTarget(e, n, `/workunits/${n.workUnitId}`)}
                        className="text-[10px] px-1.5 py-0.5 rounded border u-accent-border u-accent-dim flex-shrink-0"
                        title="打开 WorkUnit 详情"
                      >
                        WU
                      </button>
                    )}
                    {n.pmoId && (
                      <button
                        type="button"
                        onClick={e => openTarget(e, n, `/pmo/project/${n.pmoId}`)}
                        className="text-[10px] px-1.5 py-0.5 rounded border u-accent-border u-accent-dim flex-shrink-0"
                        title="打开 PMO 详情"
                      >
                        PMO
                      </button>
                    )}
                  </div>
                  <p className="text-xs u-text-2 mt-0.5 truncate">{n.content}</p>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
