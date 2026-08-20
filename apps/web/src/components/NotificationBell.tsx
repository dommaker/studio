// Notification Bell — B2-003 通知中心；#274 接后端 notifications API（JWT 身份）
// 2026-07 §5.7: 通知可点击跳转 —— 本体按 WU > PMO > 频道优先级，另附 WU/PMO 直跳小按钮
// 数据源 = 后端持久化通知（刷新不丢）+ SSE atHuman 实时增量（无后端 id，已读仅本地）
import { useState, useCallback, useRef, useEffect } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWebSocketContext } from '../api/websocketHooks';
import { api } from '../api';

interface Notification {
  id: string;
  /** 后端通知 id；null = SSE 实时条目（未持久化，已读仅本地） */
  backendId: string | null;
  channelId: string | null;
  agentName: string;
  title: string | null;
  content: string;
  time: string;
  read: boolean;
  /** 关联 WorkUnit（无则 null）——决定「WU」按钮与本体跳转优先级 */
  workUnitId: string | null;
  /** meta.pmoId（老消息可能没有，防御性取 null）——决定「PMO」按钮 */
  pmoId: string | null;
}

/** 后端 GET /notifications 返回项（NotificationService.getUserNotifications） */
interface BackendNotification {
  id: string;
  userId: string;
  type: string;
  title: string;
  content: string;
  link: string | null;
  createdAt: string | Date;
  read: boolean;
  readAt: string | Date | null;
}

/** 从后端通知 link 解析跳转目标：/workunits/:id、/pmo/project/:id、/channels/:id */
function parseLinkTargets(link: string | null): { workUnitId: string | null; pmoId: string | null; channelId: string | null } {
  const result = { workUnitId: null, pmoId: null, channelId: null };
  if (!link) return result;
  const wu = /\/workunits\/([^/?#]+)/.exec(link);
  if (wu) result.workUnitId = wu[1];
  const pmo = /\/pmo\/project\/([^/?#]+)/.exec(link);
  if (pmo) result.pmoId = pmo[1];
  const ch = /\/channels\/([^/?#]+)/.exec(link);
  if (ch) result.channelId = ch[1];
  return result;
}

function fromBackend(n: BackendNotification): Notification {
  const targets = parseLinkTargets(n.link);
  const created = new Date(n.createdAt);
  return {
    id: n.id,
    backendId: n.id,
    channelId: targets.channelId,
    agentName: 'System',
    title: n.title || null,
    content: (n.content || '').slice(0, 80),
    time: created.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
    read: n.read,
    workUnitId: targets.workUnitId,
    pmoId: targets.pmoId,
  };
}

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
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);
  const { onEvent } = useWebSocketContext();
  const dropdownRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const unread = notifications.filter(n => !n.read).length;

  // #274: 挂载时拉后端持久化通知（按当前登录身份过滤，Bearer 由 axios 拦截器注入）
  useEffect(() => {
    let cancelled = false;
    api.get('/notifications')
      .then(res => {
        if (cancelled) return;
        const rows = (res.data as BackendNotification[]) ?? [];
        setNotifications(prev => [...prev.filter(n => n.backendId === null), ...rows.map(fromBackend)]);
      })
      .catch(() => { /* 拉取失败不阻塞铃铛，保留空态/SSE 增量 */ });
    return () => { cancelled = true; };
  }, []);

  // Listen for @human messages via SSE（实时增量，刷新即丢，由后端通知承担持久面）
  useEffect(() => {
    let flashTimer: ReturnType<typeof setInterval> | null = null;
    const originalTitle = document.title;

    const unsub = onEvent((msg) => {
      if (msg.event_type === 'channel.message_sent') {
        const data = msg.data as ChannelMessageSentData | undefined;
        if (data?.message?.meta?.atHuman) {
          const m = data.message;
          setNotifications(prev => [{
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
    api.post('/notifications/read-all').catch(() => { /* 本地已乐观更新 */ });
  }, []);

  const markRead = useCallback((id: string) => {
    const target = notifications.find(x => x.id === id);
    setNotifications(prev => prev.map(x => x.id === id ? { ...x, read: true } : x));
    if (target?.backendId) {
      api.post(`/notifications/${target.backendId}/read`).catch(() => { /* 本地已乐观更新 */ });
    }
  }, [notifications]);

  // 点通知本体：跳转优先级 WU 详情 > PMO 详情 > 频道
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
