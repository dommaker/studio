// 通知中心共享 store（#274 后端持久面 + SSE atHuman 实时增量）——自 NotificationBell
// 本地 state 提升：频道页进页需把本频道未读通知标记已读（打开即读），读态须跨组件共享。
// 已读动作统一在此：本地乐观更新 + 后端条目同步 POST（SSE 条目 backendId null，仅本地）。
import { create } from 'zustand';
import { api } from '../api';
import { formatShortTime } from '../utils/datetime';

export interface Notification {
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
export function parseLinkTargets(link: string | null): { workUnitId: string | null; pmoId: string | null; channelId: string | null } {
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
  return {
    id: n.id,
    backendId: n.id,
    channelId: targets.channelId,
    agentName: 'System',
    title: n.title || null,
    content: (n.content || '').slice(0, 80),
    time: formatShortTime(n.createdAt),
    read: n.read,
    workUnitId: targets.workUnitId,
    pmoId: targets.pmoId,
  };
}

interface NotificationState {
  notifications: Notification[];
  /** 拉后端持久化通知：SSE 实时条目（backendId null）保留，后端行替换持久面；失败不阻塞 */
  loadFromBackend: () => Promise<void>;
  /** SSE atHuman 实时增量入列（内存 cap 50） */
  pushSse: (n: Notification) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  /** 打开频道即读：把 link 指向该频道的未读通知标记已读（本地 + 后端条目逐条 POST） */
  markChannelRead: (channelId: string) => void;
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
  notifications: [],

  loadFromBackend: async () => {
    try {
      const res = await api.get('/notifications');
      const rows = (res.data as BackendNotification[]) ?? [];
      set(state => ({
        notifications: [...state.notifications.filter(n => n.backendId === null), ...rows.map(fromBackend)],
      }));
    } catch { /* 拉取失败不阻塞铃铛，保留空态/SSE 增量 */ }
  },

  pushSse: (n) =>
    set(state => ({ notifications: [n, ...state.notifications.slice(0, 49)] })),

  markRead: (id) => {
    const target = get().notifications.find(x => x.id === id);
    set(state => ({
      notifications: state.notifications.map(x => (x.id === id ? { ...x, read: true } : x)),
    }));
    if (target?.backendId) {
      api.post(`/notifications/${target.backendId}/read`).catch(() => { /* 本地已乐观更新 */ });
    }
  },

  markAllRead: () => {
    set(state => ({ notifications: state.notifications.map(n => ({ ...n, read: true })) }));
    api.post('/notifications/read-all').catch(() => { /* 本地已乐观更新 */ });
  },

  markChannelRead: (channelId) => {
    const targets = get().notifications.filter(n => !n.read && n.channelId === channelId);
    if (targets.length === 0) return;
    set(state => ({
      notifications: state.notifications.map(n =>
        (!n.read && n.channelId === channelId) ? { ...n, read: true } : n),
    }));
    for (const t of targets) {
      if (t.backendId) {
        api.post(`/notifications/${t.backendId}/read`).catch(() => { /* 本地已乐观更新 */ });
      }
    }
  },
}));
