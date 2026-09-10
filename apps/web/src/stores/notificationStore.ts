// 行动中心共享 store（#468 统一行动中心）——通知中心 store 重塑：
// 「需要我做什么」两类事实一个端点（GET /action-center）：
// - stateItems 状态派生（reply/review/confirm，无已读概念、状态变即消，整体替换）；
// - notifications 事件持久（已读/未读墓碑）+ unreadCount。
// 已读动作统一在此：本地乐观更新（含 unreadCount 同步）+ 后端 POST。
// SSE 不再直接入列（pushSse 已删），只作失效触发由 NotificationBell 重拉。
import { create } from 'zustand';
import { api } from '../api';
import { formatShortTime } from '../utils/datetime';

/** 状态派生待办（reply=blocked+waitingForInput 待回复 / review=in_review 闸门类待验收 / confirm=pending 待确认） */
export interface StateItem {
  kind: 'reply' | 'review' | 'confirm';
  wuId: string;
  /** 展示口径 = metadata.title ?? scope（后端 parseWuTitle 单一出口） */
  scope: string;
  channelId: string | null;
  waitingQuestion?: string;
  /** D-2（reply 深链）：触发 waitingForInput 的提问消息 id（后端派生，口径 = 频道页 chip
   *  「当前提问消息」）；缺省时跳频道不拼 ?highlight=（fail-closed） */
  messageId?: string;
  since: string;
}

export interface Notification {
  id: string;
  /** 通知类型（旧五类 + #468 新三类 wu_milestone/monitor_alert/incident） */
  type: string;
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
  /** 频道消息 id——点击跳频道时带 ?highlight= 直达该消息；经 link 的 ?highlight= 解析获得（无则 null） */
  messageId: string | null;
}

/** 后端 GET /action-center 通知段返回项（NotificationService.getUserNotifications；#468 起带 wuId/channelId 结构化直链） */
interface BackendNotification {
  id: string;
  userId: string;
  type: string;
  title: string;
  content: string;
  link: string | null;
  /** #468 结构化直链（老数据行无此字段 → undefined，回退 link 正则解析） */
  wuId?: string | null;
  channelId?: string | null;
  createdAt: string | Date;
  read: boolean;
  readAt: string | Date | null;
}

/** GET /action-center 响应负载（apps/api action-center.service） */
interface ActionCenterPayload {
  stateItems: StateItem[];
  notifications: BackendNotification[];
  unreadCount: number;
}

/** 通知 link 解析出的跳转目标（#439：频道 link 可带 ?highlight=<消息 id> 直达锚点） */
export interface LinkTargets {
  workUnitId: string | null;
  pmoId: string | null;
  channelId: string | null;
  messageId: string | null;
}

/** 从后端通知 link 解析跳转目标：/workunits/:id、/pmo/project/:id、/channels/:id（#439：频道 link 可带 ?highlight=<消息 id> 直达锚点） */
export function parseLinkTargets(link: string | null): LinkTargets {
  const result: LinkTargets = { workUnitId: null, pmoId: null, channelId: null, messageId: null };
  if (!link) return result;
  const wu = /\/workunits\/([^/?#]+)/.exec(link);
  if (wu) result.workUnitId = wu[1];
  const pmo = /\/pmo\/project\/([^/?#]+)/.exec(link);
  if (pmo) result.pmoId = pmo[1];
  const ch = /\/channels\/([^/?#]+)/.exec(link);
  if (ch) {
    result.channelId = ch[1];
    // #439：highlight 锚点仅在频道链接上有意义（与 ChannelDetailPage ?highlight 消费口径一致）
    const hl = /[?&]highlight=([^&#]+)/.exec(link);
    if (hl) result.messageId = decodeURIComponent(hl[1]);
  }
  return result;
}

function fromBackend(n: BackendNotification): Notification {
  const targets = parseLinkTargets(n.link);
  return {
    id: n.id,
    type: n.type,
    // #468：结构化直链字段优先；老数据行没有 → 回退 link 正则（pmoId/messageId 恒走 link）
    channelId: n.channelId ?? targets.channelId,
    agentName: 'System',
    title: n.title || null,
    content: (n.content || '').slice(0, 80),
    time: formatShortTime(n.createdAt),
    read: n.read,
    workUnitId: n.wuId ?? targets.workUnitId,
    pmoId: targets.pmoId,
    messageId: targets.messageId,
  };
}

interface ActionCenterState {
  stateItems: StateItem[];
  notifications: Notification[];
  unreadCount: number;
  /** 拉行动中心三段整体替换；失败不阻塞（保留现状容错） */
  load: () => Promise<void>;
  markRead: (id: string) => void;
  markAllRead: () => void;
  /** 打开频道即读：把归属该频道的未读通知标记已读（本地 + 逐条 POST），unreadCount 同步递减 */
  markChannelRead: (channelId: string) => void;
}

export const useNotificationStore = create<ActionCenterState>((set, get) => ({
  stateItems: [],
  notifications: [],
  unreadCount: 0,

  load: async () => {
    try {
      const res = await api.get('/action-center');
      const data = res.data as ActionCenterPayload;
      set({
        stateItems: data.stateItems ?? [],
        notifications: (data.notifications ?? []).map(fromBackend),
        unreadCount: data.unreadCount ?? 0,
      });
    } catch { /* 拉取失败不阻塞面板，保留现有三段 */ }
  },

  markRead: (id) => {
    const target = get().notifications.find(x => x.id === id);
    if (!target || target.read) return; // 已读不重复递减/POST
    set(state => ({
      notifications: state.notifications.map(x => (x.id === id ? { ...x, read: true } : x)),
      unreadCount: Math.max(0, state.unreadCount - 1),
    }));
    api.post(`/notifications/${id}/read`).catch(() => { /* 本地已乐观更新 */ });
  },

  markAllRead: () => {
    set(state => ({
      notifications: state.notifications.map(n => ({ ...n, read: true })),
      unreadCount: 0,
    }));
    api.post('/notifications/read-all').catch(() => { /* 本地已乐观更新 */ });
  },

  markChannelRead: (channelId) => {
    const targets = get().notifications.filter(n => !n.read && n.channelId === channelId);
    if (targets.length === 0) return;
    set(state => ({
      notifications: state.notifications.map(n =>
        (!n.read && n.channelId === channelId) ? { ...n, read: true } : n),
      unreadCount: Math.max(0, state.unreadCount - targets.length),
    }));
    for (const t of targets) {
      api.post(`/notifications/${t.id}/read`).catch(() => { /* 本地已乐观更新 */ });
    }
  },
}));
