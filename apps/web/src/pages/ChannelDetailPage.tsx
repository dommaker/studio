// Channel Detail Page — Mission Control 三栏（左频道栏 / 中对话流 / 右频道动态栏 #394 + 覆盖抽屉）
// 对话流逻辑与 B1-001/Phase 2 一致：日期分隔、已完成折叠、线程分组、NEED_INPUT 回复链路，零语义变更
import { useParams, useSearchParams } from 'react-router-dom';
import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { formatChannelName } from '@dommaker/studio-shared/web';
import { useChannelMessages } from '../hooks/useChannelEvents';
import { usePersistentStreamUI } from '../hooks/usePersistentStreamUI';
import { useStreamFollow } from '../hooks/useStreamFollow';
import { useActivityMessageItems } from '../hooks/useActivityMessageItems';
import { useChannelCardActions } from '../hooks/useChannelCardActions';
import { useWebSocketContext } from '../api/websocketHooks';
import { ChannelMessageItem } from '../components/channel/ChannelMessageItem';
import { ChannelWorkBar } from '../components/channel/ChannelWorkBar';
import { deriveStreamView, type StreamItem } from '../utils/streamView';
import { buildMessageToItemIndex } from '../utils/streamVirtual';
import { ChannelInput } from '../components/channel/ChannelInput';
import { SuggestionChips, type SuggestionChipItem } from '../components/channel/SuggestionChips';
import { ChannelTopbarMenu } from '../components/channel/ChannelTopbarMenu';
import { ChannelCurrentPmoChip } from '../components/channel/ChannelCurrentPmoChip';
import { ChannelNeedInputChip, type NeedInputTodo } from '../components/channel/ChannelNeedInputChip';
import { ChannelRail } from '../components/channel/ChannelRail';
import { ChannelActivityRail } from '../components/channel/ChannelActivityRail';
import { WorkUnitDrawer, type DrawerState } from '../components/channel/WorkUnitDrawer';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { workunitApi } from '../api/workunit';
import type { ReviewConfirmPayload, WorkUnit } from '../api/workunit';
import { renderSuggestionCopy } from '../utils/suggestionCopy';
import { getSuggestionAction } from '../utils/suggestionActions';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import axios from 'axios';
import { useNotificationStore } from '../stores/notificationStore';
import { useUnreadStore } from '../stores/unreadStore';
import { useChannelDataStore, parseChannelMembers } from '../stores/channelDataStore';
import { fanOut } from '../utils/fanOut';
import { requirementApi, type Requirement, type RequirementStatus } from '../api/requirements';
import { parseLiveWuRef } from '../components/workunit/execution-rows';
import type { Channel, ChannelMessage, ChannelSuggestion, FileRef } from '../api/channel';
import { channelApi } from '../api/channel';
import { saveLastChannelId } from '../utils/lastChannel';
import { toast } from '../utils/toast';

/** #439：?highlight 定位的翻页页数上限（50 条/页 → 最多回看 500 条），超限/翻到底降级为可见反馈 */
const HIGHLIGHT_LOCATE_MAX_PAGES = 10;

/** 视觉批次 2 ⑥：空频道态示例提示——点击走既有 prefill 通道填入输入框（不自动发送）。
 *  文案按产品 agent 命名风格（pm-agent / dev-agent / reviewer-agent），仅作起点提示，用户可改 */
const EMPTY_EXAMPLE_PROMPTS = [
  '@pm-agent 帮我拆解需求：',
  '@dev-agent 修复问题：',
  '@reviewer-agent 评审这段改动：',
];

/** #444：动作片执行错误文案——优先服务端 error 信封 message（409 拒绝原因对人可读） */
function suggestionActionErrorMessage(e: unknown): string {
  if (axios.isAxiosError(e)) {
    const msg = (e.response?.data as { error?: { message?: string } } | undefined)?.error?.message;
    if (msg) return msg;
  }
  return e instanceof Error ? e.message : String(e);
}

/** #443：带 dismiss 台账 key 的引导片（key = `ep:{wuId}:{suggestionId}`，端点派生片唯一来源 #447） */
type DismissibleChip = SuggestionChipItem & { dismissKey: string };

const REQ_STATUSES = new Set<RequirementStatus>(['open', 'in-progress', 'done', 'archived']);

/** requirement.created/updated SSE data（{ requirement } 信封，同 workunit.status_changed 的 { workunit }）
 *  → 全量 Requirement（#415：service 发布完整对象，与 REST get 同源 → 就地 upsert 零补拉，ADR D1）。
 *  必填字段缺失/坏数据 → null，跳过不编造；channelId 可选，缺省由调用方放行。 */
function parseRequirementPayload(data: unknown): Requirement | null {
  try {
    const p = (typeof data === 'string' ? JSON.parse(data) : data) as Record<string, unknown> | null;
    const req = p?.requirement as Record<string, unknown> | undefined;
    if (!req || typeof req.id !== 'string' || !req.id) return null;
    if (typeof req.seq !== 'number' || !Number.isFinite(req.seq)) return null;
    if (typeof req.title !== 'string' || typeof req.createdAt !== 'string' || typeof req.createdBy !== 'string') return null;
    if (typeof req.status !== 'string' || !REQ_STATUSES.has(req.status as RequirementStatus)) return null;
    return {
      id: req.id,
      seq: req.seq,
      title: req.title,
      status: req.status as RequirementStatus,
      // channelId 缺省不落 key（legacy 记录可能无此字段）——updated 全量合并时不抹掉已有条目已知的归属
      ...(typeof req.channelId === 'string' ? { channelId: req.channelId } : {}),
      createdAt: req.createdAt,
      createdBy: req.createdBy,
      ...(Array.isArray(req.docs) ? { docs: req.docs.filter((d): d is string => typeof d === 'string') } : {}),
      ...(typeof req.description === 'string' ? { description: req.description } : {}),
      ...((typeof req.projectId === 'string' || req.projectId === null)
        ? { projectId: req.projectId as string | null } : {}),
    };
  } catch {
    return null;
  }
}

export function ChannelDetailPage() {
  const { id } = useParams<{ id: string }>();
  // #393：记录最近访问频道（/ 与 /channels 重定向落点，spec §2）
  useEffect(() => { if (id) saveLastChannelId(id); }, [id]);
  const [channel, setChannel] = useState<Channel | null>(null);
  const { messages, loading, sendMessage, loadMore, hasMore, refresh, syncPruning } = useChannelMessages(id);
  const [sending, setSending] = useState(false);
  // 折叠 UI 状态（showCompleted / collapsedThreads / expandedProcGroups）按频道持久化（Step 3），
  // setter 语义同 useState；线程默认全部展开，collapsedThreads 只存手动收起的锚点 id
  const {
    showCompleted, setShowCompleted,
    collapsedThreads, setCollapsedThreads,
    expandedProcGroups, setExpandedProcGroups,
  } = usePersistentStreamUI(id);
  const [replyTo, setReplyTo] = useState<ChannelMessage | null>(null);
  // REQ 需求编号（vision §5.3）：本频道需求集；#394 起喂右栏「频道动态」REQ 链路卡（原中栏 chips 条移除）
  const [channelReqs, setChannelReqs] = useState<Requirement[]>([]);
  // #440：本频道 WU 全集——阶段条 WU 数据本体 + 各卡片数据源
  // （REST 打底 + status_changed SSE upsert + 决策 9 重连对齐；「当前工单」拣选 #447 起由建议端点裁决）
  const [channelWus, setChannelWus] = useState<WorkUnit[]>([]);
  // #440：建议片 dismiss 台账（会话级，key = `ep:{wuId}:{suggestionId}`，同 key 不复活）+ 输入框 prefill 通道
  const [dismissedSuggestionKeys, setDismissedSuggestionKeys] = useState<Set<string>>(new Set());
  const [inputPrefill, setInputPrefill] = useState<{ text: string; nonce: number } | undefined>(undefined);
  // #443（spec #441）：端点派生建议（GET /channels/:id/suggestions）——引导片唯一来源（#447 静态映射已删）；
  // currentWuId = 后端拣选的「频道当前工单」（阶段条与引导片同源消费，口径单源在后端）
  const [channelSuggestions, setChannelSuggestions] = useState<ChannelSuggestion[]>([]);
  const [currentWuId, setCurrentWuId] = useState<string | null>(null);
  // Mission Control 右抽屉：WorkUnit 详情 / REQ 全链路
  const [drawer, setDrawer] = useState<DrawerState>(null);
  // #395（spec §4.6）窄屏降级断点：<768 左栏并入全局 Sidebar（本页卸载内联 ChannelRail）；
  // <1024 右栏卸载 → 顶栏「频道动态」入口 + 覆盖滑出抽屉（actRailOpen）。
  // matchMedia 缺失（jsdom）回落宽屏：内联三栏齐挂、覆盖层不开
  const mdUp = useMediaQuery('(min-width: 768px)', true);
  const lgUp = useMediaQuery('(min-width: 1024px)', true);
  const [actRailOpen, setActRailOpen] = useState(false);
  // #242 live 执行状态条：#322 下沉至 ChannelLiveBars 自持有 useChannelLiveExecutions，
  // step 事件不再触发本页整树重渲；2026-09 并入 ChannelWorkBar（见渲染段 <ChannelWorkBar>）

  useEffect(() => {
    if (!id) return;
    channelApi.get(id).then(r => {
      setChannel(r.data.data);
      // #403：成员面写穿（页面本就拉频道记录，白捡的成员数据源；store 缺拉取时自行兜底）
      useChannelDataStore.getState().setMembers(id, parseChannelMembers(r.data.data.members));
    }).catch(() => {});
  }, [id]);

  // 打开频道即读：本频道未读通知（SSE @human 实时条目 + link 指向本频道的后端通知）标记已读
  const markChannelRead = useNotificationStore(s => s.markChannelRead);
  useEffect(() => {
    if (id) markChannelRead(id);
  }, [id, markChannelRead]);

  // #413「正在看」语义：本页是频道查看的权威视角——active 写入 unreadStore（active 频道
  // 不涨未读徽章 + 进页即清零）；卸载/切走回 null，此后消息恢复累加
  useEffect(() => {
    useUnreadStore.getState().setActiveChannel(id ?? null);
    return () => useUnreadStore.getState().setActiveChannel(null);
  }, [id]);

  // F5/#468：NEED_INPUT 待办 = 行动中心投影——notificationStore.stateItems 中本频道 reply 项。
  // 本地 REST 打底 + workunit.status_changed SSE upsert 维护机制已删（不发明第五套信号）；
  // 行动中心重拉由 NotificationBell（全局挂载于 TopNav）的 SSE 失效触发承担，本页不自行 load()。
  // #468 设计稿：reply 不再排除闸门类（decision/spec/plan），排除规则改为面板分区解决
  const { onEvent, onReconnect } = useWebSocketContext();
  const stateItems = useNotificationStore(s => s.stateItems);
  const waitingWus = useMemo<NeedInputTodo[]>(() =>
    stateItems
      .filter(i => i.kind === 'reply' && i.channelId === id)
      .map(i => ({ wuId: i.wuId, question: i.waitingQuestion ?? i.scope })),
    [stateItems, id]);

  const reloadChannelReqs = useCallback(() => {
    if (!id) return;
    requirementApi.list({ channelId: id })
      .then(r => setChannelReqs(r.data.data))
      .catch(() => {});
  }, [id]);

  // #440：channelWus 打底（建议片/阶段条数据源；失败静默——两片只是引导，不阻断频道使用）
  const reloadChannelWus = useCallback(() => {
    if (!id) return;
    workunitApi.list({ channelId: id, limit: 100 })
      .then(r => setChannelWus(r.data.data))
      .catch(() => {});
  }, [id]);

  // #443：端点派生建议打底（fail-closed：负载畸形/条目缺字段 → 空集，不渲染不编造；失败静默）。
  // #447：currentWuId 同源消费（阶段条「当前工单」唯一口径）；非字符串 → null
  const reloadSuggestions = useCallback(() => {
    if (!id) return;
    channelApi.getSuggestions(id)
      .then(r => {
        const raw: unknown = r.data?.data?.suggestions;
        const list = Array.isArray(raw) ? raw : [];
        setChannelSuggestions(list.filter((s): s is ChannelSuggestion =>
          !!s && typeof s.id === 'string' && typeof s.kind === 'string'
          && !!s.params && typeof s.params === 'object',
        ));
        const rawWuId: unknown = r.data?.data?.currentWuId;
        setCurrentWuId(typeof rawWuId === 'string' ? rawWuId : null);
      })
      .catch(() => {});
  }, [id]);

  // 决策 9（SSE 负载加深）：SSE 断线重连 → 受影响面一次性 refetch（无序号/校验机制）：
  // 消息面 refresh + REQ chips 打底面 + #403 频道数据面三切片强刷
  // （#468：waitingWus 面已删——行动中心重拉由 NotificationBell 的 onReconnect 承担）
  useEffect(() => {
    return onReconnect(() => {
      void refresh();
      reloadChannelReqs();
      reloadChannelWus();
      reloadSuggestions();
      if (!id) return;
      const channelData = useChannelDataStore.getState();
      void channelData.ensureVocabulary(id, { maxAgeMs: 0 });
      void channelData.ensureCurrentPmo(id, { maxAgeMs: 0 });
      void channelData.ensureMembers(id, { maxAgeMs: 0 });
    });
  }, [onReconnect, refresh, reloadChannelReqs, reloadChannelWus, reloadSuggestions, id]);

  useEffect(() => {
    reloadChannelWus();
  }, [reloadChannelWus]);

  useEffect(() => {
    reloadSuggestions();
  }, [reloadSuggestions]);

  useEffect(() => {
    if (!id) return;
    return onEvent(msg => {
      if (msg.event_type !== 'workunit.status_changed') return;
      const wu = parseLiveWuRef(msg.data);
      if (!wu || wu.channelId !== id) return;
      // #440：channelWus 同步 upsert（轻量负载只带 id/status/metadata/type/scope/parentId，其余字段保留旧值；
      // 新 WU 以默认值补全，时间戳类字段等下次打底/重连对齐）
      setChannelWus(prev => {
        const idx = prev.findIndex(w => w.id === wu.id);
        const nowIso = new Date().toISOString();
        if (idx < 0) {
          return [...prev, {
            id: wu.id, parentId: wu.parentId, dependsOn: '', type: wu.type ?? 'task', scope: wu.scope ?? '',
            assigneeId: null, status: wu.status, failureType: null, retryCount: 0, timeoutAt: null,
            channelId: wu.channelId, metadata: wu.metadata, createdAt: nowIso, updatedAt: nowIso,
            claimedAt: null, completedAt: null,
          }];
        }
        const next = [...prev];
        next[idx] = {
          ...next[idx],
          status: wu.status,
          metadata: wu.metadata ?? next[idx].metadata,
          type: wu.type ?? next[idx].type,
          scope: wu.scope ?? next[idx].scope,
          parentId: wu.parentId ?? next[idx].parentId,
          updatedAt: nowIso,
        };
        return next;
      });
      // #443：状态变化后端点派生建议重拉（复用既有事件，不新增事件类型；推导输入含 loop 心跳等
      // 无事件信号，由后端宽限期吸收，前端不做实时）
      reloadSuggestions();
    });
  }, [id, onEvent, reloadSuggestions]);

  // REQ 需求编号（vision §5.3）：本频道需求 chips；REST 打底（reloadChannelReqs，见上）+
  // requirement.created/updated SSE 增量（批 2 决策 6：摘 messages.length 依赖；#415 负载 = { requirement } 全量，就地 upsert 零补拉）
  useEffect(() => {
    reloadChannelReqs();
  }, [reloadChannelReqs]);

  useEffect(() => {
    if (!id) return;
    return onEvent(msg => {
      if (msg.event_type !== 'requirement.created' && msg.event_type !== 'requirement.updated') return;
      const req = parseRequirementPayload(msg.data);
      if (!req) return;
      // 负载带 channelId → 按频道过滤；缺省（防御）放行
      if (req.channelId && req.channelId !== id) return;
      // #403 白捡触发器（ADR 决策 3）：REQ 变更可能改变 current-pmo 派生 → 失效强刷（零成本接线）
      if (id) useChannelDataStore.getState().invalidateCurrentPmo(id);
      if (msg.event_type === 'requirement.created') {
        // 负载即全量（与 REST get 同源）→ 就地 upsert（updater 内按 id 去重），零补拉（#415）
        setChannelReqs(prev => (prev.some(x => x.id === req.id) ? prev : [...prev, req]));
        return;
      }
      // updated：负载全量覆盖已有条目；列表没有说明打底/created 未覆盖，交由重连 refetch（批 3 决策 9）
      setChannelReqs(prev => {
        const idx = prev.findIndex(r => r.id === req.id);
        if (idx < 0) return prev;
        const next = [...prev];
        next[idx] = { ...prev[idx], ...req };
        return next;
      });
    });
  }, [id, onEvent]);

  // 统一卡片 action 路由：#322 抽成 useChannelCardActions（dispatch 单一入口，
  // 卡片 action 类型 → api 调用映射在 hook 内，映射断言见 hooks/__tests__/useChannelCardActions.test.ts）
  const handleAction = useChannelCardActions({ channelId: id, messages, refresh });

  const handleReply = useCallback((message: ChannelMessage) => {
    setReplyTo(message);
  }, []);

  // #322：稳定 props 契约——messages 渲染期镜像，findMessage identity 不随 messages 变化
  // （memo 化的 ChannelMessageItem 不再因消息集更新拿到新函数引用；读取语义不变）
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const findMessage = useCallback((msgId: string) => {
    return messagesRef.current.find(m => m.id === msgId);
  }, []);

  // F5: 挂起集合（由 waitingWus 派生）
  const waitingWuIds = useMemo(() => new Set(waitingWus.map(w => w.wuId)), [waitingWus]);

  // #447（spec #441 收尾）：「频道当前工单」拣选唯一正本 = 后端建议端点 currentWuId
  // （前端静态映射 wuSuggestions 与 pickCurrentWu 本地副本已删，杜绝前后端口径分叉）。
  // 阶段条 WU 本体取自 channelWus；端点 id 命中不了本频道列表（时序 skew）→ null 不渲染（fail-closed 不编造）
  const currentWu = useMemo(
    () => channelWus.find(w => w.id === currentWuId) ?? null,
    [channelWus, currentWuId],
  );

  // 批次 D-2 项6（频道内闸门 1 击化）：工作条闸门动作写路径——直调 API + 响应体就地并入 channelWus
  // （抽屉同款直替口径）；状态变化另有 status_changed SSE upsert + 建议重拉（currentWuId 重拣选）兜底
  const applyGateResult = useCallback((updated: WorkUnit) => {
    setChannelWus(prev => prev.map(w => (w.id === updated.id ? { ...w, ...updated } : w)));
  }, []);
  const workBarGate = useMemo(() => {
    if (!currentWu) return undefined;
    const wuId = currentWu.id;
    return {
      onReviewPassed: async (summary?: string, assigneeId?: string, confirm?: ReviewConfirmPayload) => {
        const r = await workunitApi.reviewPassed(wuId, summary, assigneeId, confirm);
        applyGateResult(r.data);
      },
      onReviewRejected: async (reason?: string) => {
        const r = await workunitApi.reviewRejected(wuId, reason);
        applyGateResult(r.data);
      },
      onConfirmPending: async () => {
        const r = await workunitApi.transitionStatus(wuId, 'unassigned');
        applyGateResult(r.data);
      },
    };
  }, [currentWu, applyGateResult]);

  // #443：端点派生建议 → 文案模板渲染成引导片（未知模板 id → 跳过，fail-closed）
  // #446：prompt 形态的预填指令本体由后端 text 字段承载，透传给 SuggestionChips（点击 → onPick(text)）
  const endpointChips = useMemo<DismissibleChip[]>(() => channelSuggestions.flatMap(s => {
    const copy = renderSuggestionCopy(s);
    if (!copy) return [];
    return [{ id: s.id, kind: s.kind, text: s.text, label: copy.label, hint: copy.hint, dismissKey: `ep:${s.params.wuId ?? ''}:${s.id}` }];
  }), [channelSuggestions]);
  // #447：引导片 = 端点派生片（唯一来源；dismiss 台账按 dismissKey 过滤，会话级）
  const visibleChips = useMemo<DismissibleChip[]>(
    () => endpointChips.filter(c => !dismissedSuggestionKeys.has(c.dismissKey)),
    [endpointChips, dismissedSuggestionKeys],
  );

  // #444：确定性动作片（补派评审等）——点击 → 一次确认 → 直调确定性接口（与自动化同原语），
  // 不经消息路由；生效后重拉建议，前置条件转假片消失/更新。失败原因内联进弹窗，不静默。
  const [pendingSuggestionAction, setPendingSuggestionAction] = useState<{ id: string; wuId: string; wuTitle: string } | null>(null);
  const [suggestionActionError, setSuggestionActionError] = useState<string | null>(null);
  const [suggestionActionRunning, setSuggestionActionRunning] = useState(false);

  const handleSuggestionAction = useCallback((item: SuggestionChipItem) => {
    const def = getSuggestionAction(item.id);
    if (!def) return; // fail-closed：未注册动作不执行
    const s = channelSuggestions.find(x => x.id === item.id);
    if (!s?.params.wuId) return; // 缺工单上下文不执行
    setSuggestionActionError(null);
    setPendingSuggestionAction({ id: item.id, wuId: s.params.wuId, wuTitle: s.params.wuTitle ?? s.params.wuId });
  }, [channelSuggestions]);

  const runSuggestionAction = useCallback(async () => {
    if (!pendingSuggestionAction) return;
    const def = getSuggestionAction(pendingSuggestionAction.id);
    if (!def) return;
    setSuggestionActionRunning(true);
    try {
      await def.run(pendingSuggestionAction.wuId);
      setPendingSuggestionAction(null);
      reloadSuggestions(); // 状态回扫：子单建出 → 前置条件转假 → 片消失/更新
    } catch (e) {
      setSuggestionActionError(suggestionActionErrorMessage(e));
    } finally {
      setSuggestionActionRunning(false);
    }
  }, [pendingSuggestionAction, reloadSuggestions]);

  const pendingActionDef = pendingSuggestionAction ? getSuggestionAction(pendingSuggestionAction.id) : null;

  // #279（走查 F4）：每个挂起 WU 的「当前提问消息」= 该 WU 最新一条非人类消息。
  // badge/回复区只落在这一条（同 WU 多消息不再一屏多个回复框）；chip 定位也用它
  const latestQuestionIdByWu = useMemo(() => {
    const map = new Map<string, { id: string; at: number }>();
    for (const m of messages) {
      if (!m.workUnitId || m.authorType === 'human') continue;
      const at = new Date(m.createdAt).getTime();
      const prev = map.get(m.workUnitId);
      if (!prev || at >= prev.at) map.set(m.workUnitId, { id: m.id, at });
    }
    return new Map([...map].map(([wuId, v]) => [wuId, v.id]));
  }, [messages]);

  // #279（走查 F4）：挂起 WU 的当前提问消息若是线程回复（agent 追问），提升到主流可见
  const promotedQuestionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const wu of waitingWus) {
      const msgId = latestQuestionIdByWu.get(wu.wuId);
      if (msgId) ids.add(msgId);
    }
    return ids;
  }, [waitingWus, latestQuestionIdByWu]);

  // F5: 消息是否为关联 WorkUnit 的当前提问（badge/内嵌回复区只落在这一条）
  const isWaitingForInput = useCallback((msg: ChannelMessage) => {
    return !!msg.workUnitId && waitingWuIds.has(msg.workUnitId) && latestQuestionIdByWu.get(msg.workUnitId) === msg.id;
  }, [waitingWuIds, latestQuestionIdByWu]);

  // #285: agent 消息 inline-code 文件 chip 词表——#403 起读 channelDataStore（与 ChannelInput
  // 共享一份拉取；按 channelId 键控无跨频道串词表）；失败静默降级，不渲染 chip
  const fileVocabulary = useChannelDataStore((s) => (id ? s.vocabulary[id] : undefined));
  useEffect(() => {
    if (!id) return;
    void useChannelDataStore.getState().ensureVocabulary(id);
  }, [id]);

  // #285 AC4: 文件 chip 第一优先词表 = 各 agent 消息所属 WU 的产出/修改文件集
  // （distinct workUnitId 逐个拉一次并缓存；拿不到/为空 → 该 WU 降级候选集词表，行为不变）
  const [wuChangedFiles, setWuChangedFiles] = useState<Record<string, string[]>>({});
  const wuFilesFetchedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const wuIds = [...new Set(
      messages.filter(m => m.authorType === 'agent' && m.workUnitId).map(m => m.workUnitId!),
    )];
    const pending = wuIds.filter(wuId => !wuFilesFetchedRef.current.has(wuId));
    if (pending.length === 0) return;
    let cancelled = false;
    for (const wuId of pending) wuFilesFetchedRef.current.add(wuId);
    void (async () => {
      const results = await fanOut(pending, wuId => workunitApi.getChangedFiles(wuId));
      if (!cancelled) {
        setWuChangedFiles(prev => {
          const next = { ...prev };
          for (let i = 0; i < pending.length; i++) {
            const r = results[i];
            next[pending[i]] = r.ok ? r.value.data?.data?.files ?? [] : []; // 失败静默降级：该 WU 走候选集词表
          }
          return next;
        });
      }
    })();
    return () => { cancelled = true; };
  }, [messages]);

  // AC-C3: 线程收起/展开（2026-09 折叠层级 4→2：默认全部展开，collapsedThreads 存手动收起的锚点 id）
  const toggleThread = useCallback((anchorId: string) => {
    setCollapsedThreads(prev => {
      const next = new Set(prev);
      if (next.has(anchorId)) next.delete(anchorId);
      else next.add(anchorId);
      return next;
    });
  }, [setCollapsedThreads]);

  // 线程内过程消息组的展开状态（保持一层折叠：默认收拢，key = proc-<首条消息 id>）
  const toggleProcGroup = useCallback((key: string) => {
    setExpandedProcGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, [setExpandedProcGroups]);

  // #416：右栏消息摘要投影——右栏只消费 card/agent WU 条目集（不再收全量 messages）；
  // 无关增量（人类插话等）投影等值 → 引用保持 → memo 化的右栏整栏零重渲
  const activityMessageItems = useActivityMessageItems(messages);

  // 定位到埋在被收起线程里的目标消息前，移除其锚点的收起标记（默认已展开，
  // 本来就不在 collapsedThreads → 返回原引用，不制造无意义新 Set 触发重渲）
  const ensureThreadExpanded = useCallback((anchorId: string) => {
    setCollapsedThreads(prev => {
      if (!prev.has(anchorId)) return prev;
      const next = new Set(prev);
      next.delete(anchorId);
      return next;
    });
  }, [setCollapsedThreads]);

  // #279（决策 #250 D4）：chip 点条目 → 滚动定位到该 WU 当前提问消息并高亮（2s 后消退）。
  // 提问消息若埋在被用户收起的线程里，先把所属线程展开
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const locateWaitingQuestion = useCallback((wuId: string) => {
    const msgId = latestQuestionIdByWu.get(wuId);
    if (!msgId) return;
    const target = messages.find(m => m.id === msgId);
    if (target?.replyToId) ensureThreadExpanded(target.replyToId);
    setHighlightId(msgId);
  }, [latestQuestionIdByWu, messages, ensureThreadExpanded]);

  // 通知中心点击直达（?highlight=<mid>）：复用上方高亮定位机制，滚动到该消息并高亮 2s。
  // 每个 mid 只消费一次（防消息流更新反复重置高亮）；首拉未完成（loading）时等下一轮 messages。
  // #439：目标掉出已加载分页时沿 #319 翻页游标向前翻页找目标所在页（上限 HIGHLIGHT_LOCATE_MAX_PAGES
  // 页）；翻到底/超限/翻页无新内容 → toast 可见反馈，不静默（原「已知留白」补齐）。
  const [searchParams] = useSearchParams();
  const highlightConsumedRef = useRef<string | null>(null);
  /** #439：正在为哪个 mid 跑翻页定位循环（同 mid 防重入；定位成功/终局反馈后清空） */
  const highlightLocatingRef = useRef<string | null>(null);
  // 翻页循环是异步长任务，经 ref 读最新快照，避免闭包锁旧值
  const locateSnapshotRef = useRef({ messages, hasMore, loadMore });
  locateSnapshotRef.current = { messages, hasMore, loadMore };
  useEffect(() => {
    const mid = searchParams.get('highlight');
    if (!mid || highlightConsumedRef.current === mid) return;
    if (loading) return; // 首拉未完成，等下一轮（防空列表误判不可达）
    const target = messages.find(m => m.id === mid);
    if (target) {
      highlightConsumedRef.current = mid;
      highlightLocatingRef.current = null;
      if (target.replyToId) ensureThreadExpanded(target.replyToId);
      setHighlightId(mid);
      return;
    }
    // 目标不在已加载消息集：启动带页数上限的翻页定位循环（进行中则防重入）。
    // 定位/高亮动作仍由上方分支在目标载入后执行，本循环只负责翻页与终局反馈。
    if (highlightLocatingRef.current === mid) return;
    highlightLocatingRef.current = mid;
    void (async () => {
      for (let page = 0; page < HIGHLIGHT_LOCATE_MAX_PAGES; page++) {
        if (highlightLocatingRef.current !== mid) return; // 已被上方分支定位/消费
        if (locateSnapshotRef.current.messages.some(m => m.id === mid)) return; // 已载入，交给 effect 定位
        if (!locateSnapshotRef.current.hasMore) break; // 翻到底
        const prepended = await locateSnapshotRef.current.loadMore();
        if (!prepended) break; // 翻页失败/无新内容，终止防空转
        // loadMore resolve 时 React 尚未提交新快照——让出一个 macrotask 等 ref 刷新，
        // 否则下一轮判空读旧快照会多翻一页（目标恰在末页时甚至可能误报不可达）
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      if (highlightLocatingRef.current !== mid) return;
      highlightLocatingRef.current = null;
      if (!locateSnapshotRef.current.messages.some(m => m.id === mid)) {
        highlightConsumedRef.current = mid;
        toast.warning('该消息太旧或已删除，无法定位');
      }
    })();
  }, [searchParams, messages, loading, ensureThreadExpanded]);

  // 里程碑判定（不折叠）：人类消息 / 卡片消息 / 等待回复 / 最后一条回复——已迁入 deriveStreamView（#322）

  const openWu = useCallback((wuId: string) => setDrawer({ kind: 'wu', id: wuId }), []);
  // #284（决策 #250 D6）：analysis_confirm 接力卡「去确认」——打开即弹确认对话框
  const openWuConfirm = useCallback((wuId: string) => setDrawer({ kind: 'wu', id: wuId, autoApprove: true }), []);
  // #467：plan_ruling 裁决轮接力卡「去裁决」——打开即弹 PlanRulingDialog
  const openWuRuling = useCallback((wuId: string) => setDrawer({ kind: 'wu', id: wuId, autoRuling: true }), []);
  const openReq = useCallback((reqId: string) => setDrawer({ kind: 'req', id: reqId }), []);

  // #395：覆盖态频道动态里点 REQ/WU → 收起覆盖层再开详情抽屉（窄屏不叠加两层）；
  // 窗口拉宽回 ≥1024 时覆盖层状态一并复位（防再收窄时莫名重开）
  const openWuFromRailOverlay = useCallback((wuId: string) => { setActRailOpen(false); openWu(wuId); }, [openWu]);
  const openReqFromRailOverlay = useCallback((reqId: string) => { setActRailOpen(false); openReq(reqId); }, [openReq]);
  useEffect(() => { if (lgUp) setActRailOpen(false); }, [lgUp]);

  // #322: 消息流管线——归组/过程折叠/连续合并/日期分隔/可见性走 deriveStreamView 纯函数，
  // useMemo 消费（消息引用与 UI 状态不变则零重算）；折叠 UI 状态由 usePersistentStreamUI 按频道持久化
  const streamView = useMemo(() => deriveStreamView(messages, {
    showCompleted,
    collapsedThreads,
    expandedProcGroups,
    promotedQuestionIds,
    isWaitingForInput,
  }), [messages, showCompleted, collapsedThreads, expandedProcGroups, promotedQuestionIds, isWaitingForInput]);

  // #325：mid→item index 映射（prepend 补偿 / 阅读位置恢复 / highlight 定位的桥）
  const messageToItemIndex = useMemo(() => buildMessageToItemIndex(streamView.items), [streamView.items]);

  // #325：滚动内容头部块（加载更早/折叠 toggle/空态）高度 → virtualizer scrollMargin
  const streamHeadRef = useRef<HTMLDivElement>(null);
  const [streamHeadH, setStreamHeadH] = useState(0);
  useEffect(() => {
    const el = streamHeadRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const update = () => setStreamHeadH(el.offsetHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 消息流滚动状态机：#322 整块抽成 useStreamFollow（PURE_MOVE 行为零变化）——
  // observed-top 台账 / 钉底跟随 / 行锚点补偿 / ResizeObserver 跟随 / 阅读位置存档全在 hook 内；
  // #325 起 virtualizer 也建在 hook 内（入参 items/messageToItemIndex/scrollMargin）
  const {
    streamRef,
    streamInnerRef,
    handleStreamScroll,
    showJumpToBottom,
    pinAndJumpToBottom,
    unpinFromBottom,
    handleLoadMore,
    ownSendPendingRef,
    awayNewCount,
    virtualizer,
    virtualEnabled,
  } = useStreamFollow({
    channelId: id,
    messages,
    loading,
    loadMore,
    items: streamView.items,
    messageToItemIndex,
    scrollMargin: streamHeadH,
  });

  // #326：首个可见消息 → 数据层降级/水合同步。仅虚拟化路径（jsdom 全量渲染不降级，
  // 页面测试语义不变）；首个 virtual item 含 overscan 缓冲，作为降级锚点足够
  const firstVirtual = virtualEnabled ? virtualizer.getVirtualItems()[0] : undefined;
  const firstVisibleItem = firstVirtual ? streamView.items[firstVirtual.index] : undefined;
  const firstVisibleMid = firstVisibleItem
    ? (firstVisibleItem.kind === 'thread' ? firstVisibleItem.anchor.id : firstVisibleItem.message.id)
    : null;
  useEffect(() => {
    if (virtualEnabled && firstVisibleMid) syncPruning(firstVisibleMid);
  }, [virtualEnabled, firstVisibleMid, syncPruning]);

  const handleSend = useCallback(async (content: string, replyToId?: string, files?: FileRef[]) => {
    setSending(true);
    // 标记「自己发送」窗口：消息落地（本 effect 链或 SSE 先去重）时跟随分支消费并清除
    ownSendPendingRef.current = true;
    try {
      // #281: files 仅在有文件引用时透传（保旧调用两参形态）
      if (files?.length) {
        await sendMessage(content, replyToId, files);
      } else {
        await sendMessage(content, replyToId);
      }
      setReplyTo(null);
    } catch (err) {
      ownSendPendingRef.current = false;
      throw err;
    } finally {
      setSending(false);
    }
  }, [sendMessage, ownSendPendingRef]);

  // F5: NEED_INPUT 卡片内嵌回复 —— 与回复按钮同链路（sendMessage + replyToId）
  // #276（P2 #15）：返回 Promise——子组件 await 真实发送结果后才置位「已回复」（不发假承诺）
  const handleInlineReply = useCallback((message: ChannelMessage, content: string) => {
    return handleSend(content, message.id);
  }, [handleSend]);

  useEffect(() => {
    if (!highlightId) return;
    // #439 走查修复：定位跳转 = 离开底部的导航意图，先解钉——否则钉底跟随在后续
    // messages 变化（翻页 prepend/水合归并）时把视口拽回底部，与定位滚动振荡
    unpinFromBottom();
    const el = streamRef.current?.querySelector(`[data-message-id="${highlightId}"]`);
    if (el) {
      // jsdom 无 scrollIntoView 实现，?. 兜底
      (el as HTMLElement | null)?.scrollIntoView?.({ block: 'center' });
    } else if (virtualEnabled) {
      // #325：目标行未渲染（掉出窗口）→ 先 scrollToIndex 把它带入窗口
      const idx = messageToItemIndex.get(highlightId);
      if (idx != null) virtualizer.scrollToIndex(idx, { align: 'center' });
    }
    const timer = setTimeout(() => setHighlightId(null), 2000);
    return () => clearTimeout(timer);
  }, [highlightId, streamRef, virtualEnabled, messageToItemIndex, virtualizer, unpinFromBottom]);

  // 批次 E-3：SSE 新到达消息渐隐高亮（白名单③状态色切换：accent-dim 底色 → 常态，仅 background-color 过渡）。
  // 口径 = 全部新到达消息（含自己发送的回显——消息模型只有 authorType 无 authorId，区分不到个人，
  // 与 useStreamFollow ownSendPending 窗口同一局限）；首拉与翻页 prepend/水合归并的历史不标
  // （createdAt 早于到达前最新一条即历史）。2s 后移类，经 .mc-msg 基类过渡渐隐
  const [freshMsgIds, setFreshMsgIds] = useState<ReadonlySet<string>>(new Set());
  const msgTrackRef = useRef<{ ids: Set<string>; latestTs: number } | null>(null);
  const freshMsgTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (messages.length === 0) return;
    const ts = (m: ChannelMessage) => new Date(m.createdAt).getTime();
    const track = msgTrackRef.current;
    if (!track) {
      // 首载：全部记为已见，不高亮
      msgTrackRef.current = { ids: new Set(messages.map(m => m.id)), latestTs: ts(messages[messages.length - 1]) };
      return;
    }
    const arrived = messages.filter(m => !track.ids.has(m.id) && ts(m) >= track.latestTs);
    for (const m of messages) track.ids.add(m.id);
    track.latestTs = Math.max(track.latestTs, ts(messages[messages.length - 1]));
    if (arrived.length === 0) return;
    setFreshMsgIds(prev => {
      const next = new Set(prev);
      for (const m of arrived) next.add(m.id);
      return next;
    });
    if (freshMsgTimerRef.current) clearTimeout(freshMsgTimerRef.current);
    freshMsgTimerRef.current = setTimeout(() => setFreshMsgIds(new Set()), 2000);
  }, [messages]);
  useEffect(() => () => { if (freshMsgTimerRef.current) clearTimeout(freshMsgTimerRef.current); }, []);

  // #322：提升为 useCallback——消除每次渲染新建的内联 render props（memo 稳定 props 契约）
  const renderMessageItem = useCallback((msg: ChannelMessage, extra: Partial<Parameters<typeof ChannelMessageItem>[0]> = {}) => (
    <ChannelMessageItem
      key={msg.id}
      message={msg}
      onAction={handleAction}
      onReply={handleReply}
      findMessage={findMessage}
      channelId={id}
      waitingForInput={isWaitingForInput(msg)}
      onOpenWorkUnit={openWu}
      onOpenWorkUnitConfirm={openWuConfirm}
      onOpenWorkUnitRuling={openWuRuling}
      onOpenRequirement={openReq}
      onInlineReply={handleInlineReply}
      fileVocabulary={fileVocabulary}
      wuChangedFiles={msg.workUnitId ? wuChangedFiles[msg.workUnitId] : undefined}
      highlight={highlightId === msg.id}
      fresh={freshMsgIds.has(msg.id)}
      {...extra}
    />
  ), [handleAction, handleReply, findMessage, id, isWaitingForInput, openWu, openWuConfirm, openWuRuling, openReq, handleInlineReply, fileVocabulary, wuChangedFiles, highlightId, freshMsgIds]);

  // #326：骨架占位行——degraded 消息（含 thread anchor）渲染为固定占位行，
  // 保留 data-message-id（锚点捕获/阅读位置仍可按 mid 定位）；水合后原位恢复。
  // #439 走查修复：highlight 目标为骨架时同样给 mc-msg-highlight——否则 ?highlight 直达
  // 老消息（掉出 PRUNE_KEEP_RECENT 被降级）定位成功但高亮不可见；水合后原位恢复为全量行。
  const renderSkeletonRow = useCallback((mid: string, dateNode: React.ReactNode) => (
    <>
      {dateNode}
      <div className={`mc-msg-skeleton${highlightId === mid ? ' mc-msg-highlight' : ''}`} data-message-id={mid}>历史消息已卸载 · 滚动经过自动加载</div>
    </>
  ), [highlightId]);

  // #325：单个 stream item 的渲染内容（日期分隔 + 消息/线程组）——外层包裹（key/测量）
  // 由调用方决定：非虚拟化路径 = 普通 div；虚拟化路径 = data-index + measureElement 行
  const renderStreamItem = useCallback((item: StreamItem) => {
    if (item.kind === 'thread') {
      if (item.anchor.degraded) {
        return renderSkeletonRow(item.anchor.id, item.showDate && (
          <div className="mc-date" key={item.dateKey}>{item.dateLabel}</div>
        ));
      }
      return (
        <>
          {item.showDate && (
            <div className="mc-date" key={item.dateKey}>
              {item.dateLabel}
            </div>
          )}
          {renderMessageItem(item.anchor, {
            isThreadAnchor: true,
            threadReplyCount: item.replyCount,
            isExpanded: item.expanded,
            onToggleThread: toggleThread,
            compact: item.compact,
          })}
          {item.expanded && item.replyCount > 0 && (
            <div className="mc-thread-replies">
              {item.replies.map(ri => {
                if (ri.kind === 'msg') {
                  return renderMessageItem(ri.message, { isThreadReply: true, compact: ri.compact });
                }
                return ri.expanded ? (
                  <div key={ri.key}>
                    <button onClick={() => toggleProcGroup(ri.key)} className="mc-collapse-toggle">
                      收起 {ri.messages.length} 条过程消息
                    </button>
                    {ri.messages.map(reply => renderMessageItem(reply, { isThreadReply: true }))}
                  </div>
                ) : (
                  <button key={ri.key} onClick={() => toggleProcGroup(ri.key)} className="mc-collapse-toggle">
                    ▸ {ri.messages.length} 条过程消息
                  </button>
                );
              })}
            </div>
          )}
        </>
      );
    }
    return (
      <>
        {item.showDate && (
          <div className="mc-date" key={item.dateKey}>
            {item.dateLabel}
          </div>
        )}
        {item.message.degraded
          ? renderSkeletonRow(item.message.id, null)
          : renderMessageItem(item.message, { compact: item.compact })}
      </>
    );
  }, [renderMessageItem, renderSkeletonRow, toggleThread, toggleProcGroup]);

  if (!id) return <div className="mc-stream-empty" style={{ height: '100%' }}>频道不存在或链接无效</div>;

  return (
    <div className="mc-ws">
      {/* 左栏：频道列表 + Agent 状态（#395：<768 卸载，并入全局 Sidebar） */}
      {mdUp && <ChannelRail activeChannelId={id} />}

      {/* 中栏：对话流 */}
      <main className="mc-main">
        <div className="mc-topbar">
          <h1 className="mc-topbar-name">{formatChannelName(channel?.name || id.slice(0, 8))}</h1>
          <span className="mc-topbar-type">
            {channel?.type === 'rnd' ? '研发频道' : channel?.type === 'decision' ? '决策频道' : '系统频道'}
          </span>
          <div className="mc-topbar-actions">
            {/* #474：「当前 PMO」提升为顶栏可见位（原藏 ⋯ 菜单）——频道上下文标识与待办信号同排可见 */}
            <ChannelCurrentPmoChip channelId={id} />
            {/* #279（决策 #250 D4）/ #468：NEED_INPUT 待办 chip——数据源 = 行动中心 stateItems 投影
                （本频道 reply 项）；E1 起为顶栏唯一待办信号位（消息头 badge 已删，见 ChannelMessageItem） */}
            <ChannelNeedInputChip items={waitingWus} onLocate={locateWaitingQuestion} />
            {/* E1（2026-09 页面重设计）：顶栏收敛 ⋯ 菜单——成员管理/默认工程/频道动态入口（<1024）
                收纳进菜单；主行动点保持输入框「发送」唯一 accent */}
            <ChannelTopbarMenu
              channelId={id}
              defaultPath={channel?.defaultPath}
              onOpenActivity={() => setActRailOpen(true)}
            />
          </div>
        </div>

        {/* 频道工作条（合并 #242/#322 live 实况条 + #440/#447 阶段条，docs/plans/2026-09-channel-workbar.md）：
            一条横带回答「这个频道的工作现在什么状态」；hook 自持有，step 事件只重渲该组件边界；
            currentWu = 建议端点 currentWuId × channelWus（拣选口径单源在后端，未命中 fail-closed 主区不渲染）；
            点击条目打开对应 WU 抽屉（过程明细仍在抽屉） */}
        <ChannelWorkBar channelId={id} currentWu={currentWu} onOpenWorkUnit={openWu} gate={workBarGate} />

        {/* Message list
            #325：头部块（空态/加载更早/折叠 toggle）与虚拟列表 spacer 分离——
            头部高度经 streamHeadRef 量作 virtualizer scrollMargin；
            虚拟化路径只渲染窗口内行（spacer 撑总高 + 块平移），非虚拟化（jsdom）全量渲染 */}
        <div className="mc-stream" ref={streamRef} onScroll={handleStreamScroll}>
          {/* mc-stream-head：滚动测量容器（streamHeadRef 挂点），无样式需求，结构化 hook（#431 定性保留） */}
          <div className="mc-stream-head" ref={streamHeadRef}>
            {loading && messages.length === 0 && (
              <div className="mc-stream-empty">加载中…</div>
            )}
            {!loading && messages.length === 0 && (
              <div className="mc-stream-empty">
                <p>发送消息开始对话</p>
                <p>@Agent 提及 Agent 创建任务</p>
                {/* 视觉批次 2 ⑥：示例提示 chip——点击经既有 prefill 通道填入输入框（不自动发送），
                    空态仅此一处渲染点（虚拟化/非虚拟化共用同一 .mc-stream 头块） */}
                <div className="mc-empty-examples">
                  {EMPTY_EXAMPLE_PROMPTS.map(text => (
                    <button
                      key={text}
                      type="button"
                      className="mc-empty-chip"
                      onClick={() => setInputPrefill(p => ({ text, nonce: (p?.nonce ?? 0) + 1 }))}
                    >
                      {text}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* B2-002: Load more */}
            {hasMore && (
              <button onClick={handleLoadMore} className="mc-loadmore">
                加载更早的消息
              </button>
            )}

            {/* B2-006: collapse completed toggle */}
            {!showCompleted && streamView.completedCount > 2 && (
              <button onClick={() => setShowCompleted(true)} className="mc-collapse-toggle">
                显示 {streamView.completedCount - 2} 条已完成消息
              </button>
            )}
            {showCompleted && streamView.completedCount > 2 && (
              <button onClick={() => setShowCompleted(false)} className="mc-collapse-toggle">
                收起已完成消息
              </button>
            )}
          </div>
          <div
            className="mc-stream-inner"
            ref={streamInnerRef}
            style={virtualEnabled ? { height: virtualizer.getTotalSize(), position: 'relative' } : undefined}
          >
            {/* B2-002: Date separators + B2-006: collapse completed + AC-C3: threads
                #322: 归组/折叠/合并/日期分隔/可见性由 deriveStreamView 算出（useMemo 消费） */}
            {virtualEnabled ? (
              <div style={{ transform: `translateY(${(virtualizer.getVirtualItems()[0]?.start ?? 0) - streamHeadH}px)` }}>
                {virtualizer.getVirtualItems().map(vi => (
                  <div key={vi.key} data-index={vi.index} ref={virtualizer.measureElement}>
                    {renderStreamItem(streamView.items[vi.index])}
                  </div>
                ))}
              </div>
            ) : (
              streamView.items.map(item => (
                <div key={item.kind === 'thread' ? item.anchor.id : item.message.id}>
                  {renderStreamItem(item)}
                </div>
              ))
            )}
          </div>
          {/* #289: 偏离底部时浮出「回到底部」（sticky 贴滚动视口底部，不占流内高度）；
              批次 E-3：钉底跟随期间到达的新消息计数进浮钮文案，点击回底后清零 */}
          {showJumpToBottom && (
            <div className="mc-jump-wrap">
              <button type="button" className="mc-jump-bottom" onClick={pinAndJumpToBottom}>
                {awayNewCount > 0 ? `↓ ${awayNewCount} 条新消息` : '↓ 回到底部'}
              </button>
            </div>
          )}
        </div>

        {/* #443–#447：引导片（唯一来源 = 建议端点派生片；prompt 点击填入输入框，status 只读，
            action 点击走下方确认弹窗直调确定性接口；会话级 dismiss） */}
        {visibleChips.length > 0 && (
          <SuggestionChips
            suggestions={visibleChips}
            onPick={(text) => setInputPrefill(p => ({ text, nonce: (p?.nonce ?? 0) + 1 }))}
            onAction={handleSuggestionAction}
            onDismiss={() => setDismissedSuggestionKeys(prev => {
              const next = new Set(prev);
              for (const c of visibleChips) next.add(c.dismissKey);
              return next;
            })}
          />
        )}

        {/* #444：动作片一次确认——文案说清点了会发生什么；失败原因内联进弹窗不静默 */}
        {pendingSuggestionAction && pendingActionDef && (
          <ConfirmDialog
            open
            title={pendingActionDef.title}
            confirmLabel={pendingActionDef.confirmLabel}
            loading={suggestionActionRunning}
            message={
              <>
                {pendingActionDef.confirmMessage(pendingSuggestionAction.wuTitle)}
                {suggestionActionError && (
                  <div className="text-xs u-err" style={{ marginTop: 8 }}>{suggestionActionError}</div>
                )}
              </>
            }
            onConfirm={() => { void runSuggestionAction(); }}
            onCancel={() => setPendingSuggestionAction(null)}
          />
        )}

        {/* Input */}
        <ChannelInput onSend={handleSend} sending={sending} replyTo={replyTo} onCancelReply={() => setReplyTo(null)} channelId={id} prefill={inputPrefill} />
      </main>

      {/* 右栏：频道动态 REQ 链路卡（#394，spec §4.1–4.3）；REQ/WU 点击仍走下方覆盖抽屉。
          #395：仅 ≥1024 内联挂载（<1024 走下方覆盖抽屉，避免藏而不卸的取数浪费） */}
      {lgUp && (
        <ChannelActivityRail
          channelId={id}
          reqs={channelReqs}
          messageItems={activityMessageItems}
          waitingWus={waitingWus}
          onOpenWu={openWu}
          onOpenReq={openReq}
        />
      )}

      {/* #395（spec §4.6）：<1024 频道动态覆盖抽屉——右侧滑出，backdrop/× 可关，
          点 REQ/WU 收起覆盖层后开详情抽屉（不叠加两层） */}
      {!lgUp && actRailOpen && (
        <div className="mc-act-overlay" role="dialog" aria-label="频道动态">
          <div className="mc-act-overlay-backdrop" onClick={() => setActRailOpen(false)} />
          <div className="mc-act-overlay-panel">
            <button
              type="button"
              className="mc-drawer-close mc-act-overlay-close"
              aria-label="关闭频道动态"
              onClick={() => setActRailOpen(false)}
            >
              ×
            </button>
            <ChannelActivityRail
              channelId={id}
              reqs={channelReqs}
              messageItems={activityMessageItems}
              waitingWus={waitingWus}
              onOpenWu={openWuFromRailOverlay}
              onOpenReq={openReqFromRailOverlay}
            />
          </div>
        </div>
      )}

      {/* 右抽屉：WorkUnit 详情 / REQ 全链路 */}
      <WorkUnitDrawer
        drawer={drawer}
        onClose={() => setDrawer(null)}
        onOpenWu={openWu}
        onOpenReq={openReq}
      />
    </div>
  );
}
