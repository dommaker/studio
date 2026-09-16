// 行动中心共享 store（#468 统一行动中心）——通知中心 store 重塑：
// 「需要我做什么」两类事实一个端点（GET /action-center）：
// - stateItems 状态派生（reply/review/confirm，无已读概念、状态变即消，整体替换）；
// - notifications 事件持久（已读/未读墓碑）+ unreadCount。
// 已读动作统一在此：本地乐观更新（含 unreadCount 同步）+ 后端 POST。
// SSE 不再直接入列（pushSse 已删），只作失效触发由 NotificationBell 重拉。
// #517：load 接 fetchDiscipline 底座（照 rosterStore 模式：TTL + single-flight + seq 守卫），
// 触发侧防抖在 NotificationBell（#489 同款 500ms trailing）。
import { create } from 'zustand';
import { api } from '../api';
import { formatShortTime } from '../utils/datetime';
import { createFetchGate, disciplinedFetch } from './fetchDiscipline';

/** load 默认 TTL：对齐全项目取数 TTL 量级（ROSTER_TTL_MS / CHANNEL_DATA_TTL_MS 同为 30s）——
 *  重复挂载 TTL 内零重拉；SSE 失效/断线重连由调用方传 maxAgeMs: 0 强拉 */
export const NOTIFICATION_TTL_MS = 30000;

/** 状态派生待办（reply=blocked+waitingForInput 待回复 / review=in_review 闸门类待验收 / confirm=pending 待确认） */
export interface StateItem {
  kind: 'reply' | 'review' | 'confirm';
  wuId: string;
  /** 展示口径 = metadata.title ?? scope（后端 parseWuTitle 单一出口） */
  scope: string;
  channelId: string | null;
  waitingQuestion?: string;
  /** D-2（reply 深链）/#533：触发 waitingForInput 的提问消息 id——「WU 当前提问消息」唯一派生点
   *  = 后端 action-center；频道页回复区/提升/chip 定位全消费此字段（前端反推已删）；
   *  缺省时各消费方 fail-closed（跳频道不拼 ?highlight=、不挂回复区） */
  messageId?: string;
  since: string;
}

/** #546：per-channel need-input 视图投影（四种消费形状单源，照 channelWorkStore.wuIdleOf 派生单源模式）——
 *  stateItems → 频道页 NEED_INPUT 面全部消费形状。口径变更（过滤规则 / fail-closed 语义）只落本函数，
 *  ChannelDetailPage / ChannelNeedInputChip / 右栏 / useChannelStream 消费同一份产物 */
export interface NeedInputView {
  /** 待办列表（chip / 右栏共用）：本频道 reply 项，question = waitingQuestion ?? scope */
  waitingWus: Array<{ wuId: string; question: string; messageId?: string }>;
  /** wuId → 当前提问 messageId——fail-closed：messageId 缺省的 WU 不进映射（前端不从已加载消息反推，#483 边界） */
  questionIdByWu: ReadonlyMap<string, string>;
  /** 提问提升集（= questionIdByWu values）——线程回复形态的提问消息提升到主流可见 */
  promotedQuestionIds: ReadonlySet<string>;
  /** 消息是否为本频道某 WU 的当前提问（badge/内嵌回复区只落这一条） */
  isWaitingForInput: (msg: { id: string; workUnitId?: string | null }) => boolean;
}

/** stateItems → per-channel need-input 投影。channelId 缺省 / 条目 channelId 为 null → 不匹配（fail-closed） */
export function needInputViewOf(stateItems: StateItem[], channelId: string | undefined): NeedInputView {
  const waitingWus = stateItems
    .filter(i => i.kind === 'reply' && i.channelId === channelId)
    .map(i => ({ wuId: i.wuId, question: i.waitingQuestion ?? i.scope, messageId: i.messageId }));
  const questionIdByWu = new Map<string, string>();
  for (const w of waitingWus) if (w.messageId) questionIdByWu.set(w.wuId, w.messageId);
  return {
    waitingWus,
    questionIdByWu,
    promotedQuestionIds: new Set(questionIdByWu.values()),
    isWaitingForInput: (msg) => !!msg.workUnitId && questionIdByWu.get(msg.workUnitId) === msg.id,
  };
}

/** F2（2026-09-16 性能体检）：NeedInputView 内容等值判定——四种消费形状全由 waitingWus 派生，
 *  waitingWus 等值即整体等值，可复用旧引用（无关频道 stateItems 变化不掀动下游派生） */
export function needInputViewEqual(a: NeedInputView, b: NeedInputView): boolean {
  if (a.waitingWus.length !== b.waitingWus.length) return false;
  return a.waitingWus.every((w, i) => {
    const o = b.waitingWus[i];
    return w.wuId === o.wuId && w.question === o.question && w.messageId === o.messageId;
  });
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
  /** 成功落库的时间戳（TTL 锚点；失败不更新 → 下次调用重试） */
  loadedAt: number | null;
  /** 进行中的拉取（single-flight 去重锚点） */
  inflight: Promise<void> | null;
  /**
   * 拉行动中心三段整体替换（TTL 门禁 + single-flight + seq 守卫，#517 接 fetchDiscipline）。
   * 永不 reject（失败不阻塞面板，保留现有三段）。maxAgeMs 缺省 NOTIFICATION_TTL_MS；
   * 传 0 强制重拉（SSE 失效、断线重连对齐等，照 rosterStore 语义）。
   */
  load: (opts?: { maxAgeMs?: number }) => Promise<void>;
  markRead: (id: string) => void;
  markAllRead: () => void;
  /** 打开频道即读：把归属该频道的未读通知标记已读（本地 + 逐条 POST），unreadCount 同步递减 */
  markChannelRead: (channelId: string) => void;
}

/** 取数纪律底座（#517，照 rosterStore #403 模式）：seq 守卫锚点。TTL / single-flight / inflight 生命周期走 disciplinedFetch */
const notificationGate = createFetchGate();

export const useNotificationStore = create<ActionCenterState>((set, get) => ({
  stateItems: [],
  notifications: [],
  unreadCount: 0,
  loadedAt: null,
  inflight: null,

  load: async (opts) => {
    const maxAgeMs = opts?.maxAgeMs ?? NOTIFICATION_TTL_MS;
    return disciplinedFetch(
      notificationGate,
      { read: () => ({ loadedAt: get().loadedAt, inflight: get().inflight }), setInflight: (p) => set({ inflight: p }) },
      { maxAgeMs },
      async (seq) => {
        try {
          const res = await api.get('/action-center');
          // seq 守卫：晚到的旧 fetch（被强拉/后续拉取超越）不回写
          if (!notificationGate.isLatest(seq)) return;
          const data = res.data as ActionCenterPayload;
          set({
            stateItems: data.stateItems ?? [],
            notifications: (data.notifications ?? []).map(fromBackend),
            unreadCount: data.unreadCount ?? 0,
            loadedAt: Date.now(),
          });
        } catch { /* 拉取失败不阻塞面板，保留现有三段；不更新 loadedAt → 下次调用重试 */ }
      },
    );
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
