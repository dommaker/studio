// Notification Bell — #468 统一行动中心：一个端点（GET /action-center）+ 一个面板。
// 面板分区：待回复/待验收/待确认（stateItems 状态派生，无已读概念、状态变即消）
// + 通知与告警（事件持久，已读/未读墓碑）。
// 数据源与已读动作住 stores/notificationStore（读态跨组件共享：频道页进页 markChannelRead）。
// SSE 只作失效触发：channel.message_sent atHuman / workunit.status_changed → 重拉；
// 断线重连重拉（#415 模式保留）；通知点击跳转优先级 wuId > 频道(?highlight=) > PMO。
import { useState, useCallback, useRef, useEffect } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWebSocketContext } from '../api/websocketHooks';
import { useNotificationStore, type Notification, type StateItem } from '../stores/notificationStore';

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
  const stateItems = useNotificationStore(s => s.stateItems);
  const notifications = useNotificationStore(s => s.notifications);
  const unreadCount = useNotificationStore(s => s.unreadCount);
  const load = useNotificationStore(s => s.load);
  const markRead = useNotificationStore(s => s.markRead);
  const markAllRead = useNotificationStore(s => s.markAllRead);
  const [open, setOpen] = useState(false);
  const { onEvent, onReconnect } = useWebSocketContext();
  const dropdownRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const replyItems = stateItems.filter(i => i.kind === 'reply');
  const reviewItems = stateItems.filter(i => i.kind === 'review');
  const confirmItems = stateItems.filter(i => i.kind === 'confirm');
  // 角标 = 未读通知 + 状态派生待办（两类「需要我做什么」合一）
  const total = unreadCount + stateItems.length;

  // #468: 挂载时拉行动中心三段（按当前登录身份过滤，Bearer 由 axios 拦截器注入）
  useEffect(() => {
    void load();
  }, [load]);

  // #415（ADR D3）：断线重连 → 行动中心一次性 refetch 打底对齐
  useEffect(() => onReconnect(() => { void load(); }), [onReconnect, load]);

  // B2-004 标题闪烁定时器：收进 ref 管理——开新闪前必清旧闪（修：10s 内多条 @human
  // 旧 interval 被覆盖引用导致永久泄漏闪烁）；归零/卸载即停（修：全部已读后仍闪到超时）
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

  // 未读通知 + 状态派生待办全清零（单条/全部已读、状态流转消失）即停闪
  useEffect(() => {
    if (total === 0) stopFlash();
  }, [total, stopFlash]);

  // 卸载清闪
  useEffect(() => stopFlash, [stopFlash]);

  // #468：SSE 只作失效触发，不再直接入列——atHuman（顺带标题闪烁）/ WU 状态流转 → 重拉
  useEffect(() => {
    const unsub = onEvent((msg) => {
      if (msg.event_type === 'channel.message_sent') {
        const data = msg.data as ChannelMessageSentData | undefined;
        if (data?.message?.meta?.atHuman) {
          void load();
          startFlash(data.message.agentName || 'Agent');
        }
      } else if (msg.event_type === 'workunit.status_changed') {
        void load();
      }
    });
    return () => { unsub(); };
  }, [onEvent, load, startFlash]);

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

  // 点状态派生项（无已读概念）：待回复优先跳频道（频道页 chip 提供定位），其余跳 WU 详情
  const openStateItem = useCallback((item: StateItem) => {
    if (item.kind === 'reply' && item.channelId) navigate(`/channels/${item.channelId}`);
    else navigate(`/workunits/${item.wuId}`);
    setOpen(false);
  }, [navigate]);

  // 点通知本体：标记已读（store 动作内含后端同步），跳转优先级 WU 详情 > 频道（?highlight= 直达消息）> PMO
  const openNotification = useCallback((n: Notification) => {
    markRead(n.id);
    if (n.workUnitId) navigate(`/workunits/${n.workUnitId}`);
    else if (n.channelId) navigate(`/channels/${n.channelId}${n.messageId ? `?highlight=${n.messageId}` : ''}`);
    else if (n.pmoId) navigate(`/pmo/project/${n.pmoId}`);
    setOpen(false);
  }, [markRead, navigate]);

  // 点 WU/PMO 小按钮：直跳目标，不触发本体跳转
  const openTarget = useCallback((e: ReactMouseEvent, n: Notification, path: string) => {
    e.stopPropagation();
    markRead(n.id);
    navigate(path);
    setOpen(false);
  }, [markRead, navigate]);

  const renderStateSection = (title: string, items: StateItem[]) => items.length > 0 && (
    <div key={title}>
      <div className="px-4 pt-2 pb-1 text-xs font-medium u-text-3">{title} ({items.length})</div>
      {items.map(item => (
        <div
          key={`${item.kind}-${item.wuId}`}
          role="button"
          tabIndex={0}
          onClick={() => openStateItem(item)}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              openStateItem(item);
            }
          }}
          className="w-full text-left px-4 py-2 u-hover-bg transition-colors cursor-pointer"
        >
          <div className="text-xs font-medium u-text truncate">{item.scope}</div>
          {item.kind === 'reply' && item.waitingQuestion && (
            <p className="text-xs u-text-2 mt-0.5 truncate">{item.waitingQuestion}</p>
          )}
        </div>
      ))}
    </div>
  );

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setOpen(!open)}
        className="relative p-1.5 rounded-lg u-hover-bg transition-colors"
        title="行动中心"
      >
        <span className="text-lg">🔔</span>
        {total > 0 && (
          <span data-visual-ignore className="absolute -top-0.5 -right-0.5 u-err-bg u-on-accent text-[var(--fs-xs)] font-bold rounded-full min-w-4 h-4 px-0.5 flex items-center justify-center">
            {total > 9 ? '9+' : total}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 u-surface border u-border rounded-lg z-50" style={{ boxShadow: 'var(--shadow-lg)' }}>
          <div className="flex items-center justify-between px-4 py-2 border-b u-border">
            <span className="text-sm font-semibold u-text">行动中心</span>
            {unreadCount > 0 && (
              <button onClick={markAllRead} className="text-xs u-accent hover:underline">
                全部已读
              </button>
            )}
          </div>

          <div className="max-h-80 overflow-y-auto">
            {renderStateSection('待回复', replyItems)}
            {renderStateSection('待验收', reviewItems)}
            {renderStateSection('待确认', confirmItems)}

            {notifications.length > 0 && (
              <>
                {stateItems.length > 0 && <div className="border-t u-border" />}
                <div className="px-4 pt-2 pb-1 text-xs font-medium u-text-3">通知与告警</div>
                {notifications.map(n => (
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
                      <span className="text-xs font-medium u-text flex-1 min-w-0 truncate">
                        {n.title ? n.title : `@${n.agentName}`}
                      </span>
                      <span className="text-[var(--fs-xs)] u-text-3 ml-auto font-mono flex-shrink-0" data-visual-ignore>{n.time}</span>
                      {n.workUnitId && (
                        <button
                          type="button"
                          onClick={e => openTarget(e, n, `/workunits/${n.workUnitId}`)}
                          className="text-[var(--fs-xs)] px-1.5 py-0.5 rounded border u-accent-border u-accent-dim flex-shrink-0"
                          title="打开任务详情"
                        >
                          任务
                        </button>
                      )}
                      {n.pmoId && (
                        <button
                          type="button"
                          onClick={e => openTarget(e, n, `/pmo/project/${n.pmoId}`)}
                          className="text-[var(--fs-xs)] px-1.5 py-0.5 rounded border u-accent-border u-accent-dim flex-shrink-0"
                          title="打开 PMO 详情"
                        >
                          PMO
                        </button>
                      )}
                    </div>
                    <p className="text-xs u-text-2 mt-0.5 truncate">{n.content}</p>
                  </div>
                ))}
              </>
            )}

            {stateItems.length === 0 && notifications.length === 0 && (
              <div className="px-4 py-8 text-center text-xs u-text-3">暂无待办与通知</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
