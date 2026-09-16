// Channel Detail Page — Mission Control 三栏（左频道栏 / 中对话流 / 右频道动态栏 #394 + 覆盖抽屉）
// 对话流逻辑与 B1-001/Phase 2 一致：日期分隔、已完成折叠、线程分组、NEED_INPUT 回复链路，零语义变更
import { useParams, useSearchParams } from 'react-router-dom';
import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { formatChannelName } from '@dommaker/studio-shared/web';
import { useChannelMessages } from '../hooks/useChannelEvents';
import { useChannelStream } from '../hooks/useChannelStream';
import { useMessageLocate } from '../hooks/useMessageLocate';
import { useMessageNav } from '../hooks/useMessageNav';
import { useActivityMessageItems } from '../hooks/useActivityMessageItems';
import { useChannelCardActions } from '../hooks/useChannelCardActions';
import { useWebSocketContext } from '../api/websocketHooks';
import { ChannelMessageItem } from '../components/channel/ChannelMessageItem';
import { ChannelMessageEnvProvider, type ChannelMessageEnv } from '../components/channel/ChannelMessageEnv';
import { ChannelStreamBody, type StreamMessageExtra } from '../components/channel/ChannelStreamBody';
import { ChannelWorkBar } from '../components/channel/ChannelWorkBar';
import { navigableIdsOf } from '../utils/streamView';
import { ChannelInput } from '../components/channel/ChannelInput';
import { SuggestionChips, type SuggestionChipItem } from '../components/channel/SuggestionChips';
import { ChannelTopbarMenu } from '../components/channel/ChannelTopbarMenu';
import { ChannelCurrentPmoChip } from '../components/channel/ChannelCurrentPmoChip';
import { ChannelNeedInputChip } from '../components/channel/ChannelNeedInputChip';
import { ChannelRail } from '../components/channel/ChannelRail';
import { ChannelActivityRail } from '../components/channel/ChannelActivityRail';
import { WorkUnitDrawer, type DrawerState } from '../components/channel/WorkUnitDrawer';
import { useMediaQuery } from '../hooks/useMediaQuery';
import type { WorkUnit } from '../api/workunit';
import { renderSuggestionCopy } from '../utils/suggestionCopy';
import { toast } from '../utils/toast';
import { getSuggestionAction } from '../utils/suggestionActions';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { SkeletonText } from '../components/ui';
import axios from 'axios';
import { useNotificationStore } from '../stores/notificationStore';
import { useUnreadStore } from '../stores/unreadStore';
import { useChannelDataStore, parseChannelMembers } from '../stores/channelDataStore';
import { useChannelWorkStore, parseRequirementPayload, wuIdleOf } from '../stores/channelWorkStore';
import { agentAnsweredOf } from '../stores/channelMessageStore';
import { useFreshMessageIds } from '../hooks/useFreshMessageIds';
import { useNeedInputView } from '../hooks/useNeedInputView';
import { useChannelWorkStoreSync } from '../hooks/useChannelWorkStoreSync';
import type { Requirement } from '../api/requirements';
import type { Channel, ChannelMessage, ChannelSuggestion, FileRef } from '../api/channel';
import { channelApi } from '../api/channel';
import { saveLastChannelId } from '../utils/lastChannel';
import { markPageEntry, emitPageFirstRender, emitReceiptRendered } from '../utils/clientPerf';

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

/** store slice 缺键（未拉到）时的稳定空集回退——防下游 memo 因每渲染新引用失效 */
const EMPTY_WUS: WorkUnit[] = [];
const EMPTY_REQS: Requirement[] = [];
const EMPTY_SUGGESTIONS: ChannelSuggestion[] = [];

export function ChannelDetailPage() {
  const { id } = useParams<{ id: string }>();
  // #393：记录最近访问频道（/ 与 /channels 重定向落点，spec §2）
  useEffect(() => { if (id) saveLastChannelId(id); }, [id]);

  // #520 测量②：client.perf 埋点③起点——进页记时（埋点①在 ChannelInput，②起点在 useChannelMessages）
  useEffect(() => { if (id) markPageEntry(id); }, [id]);
  const [channel, setChannel] = useState<Channel | null>(null);
  const { messages, loading, error, sendMessage, loadMore, hasMore, refresh, syncPruning } = useChannelMessages(id);

  // #520 测量②：渲染完成终点（effect 于提交后跑 = 渲染已完成）——
  // ③ page_load：首屏消息渲染完成（每进页至多一次，起点消费后不再发；空频道不发属正常）；
  // ② receipt_render：仅 SSE 到达时标记过的消息发事件（首拉/翻页/水合的历史消息无标记，天然跳过）
  useEffect(() => {
    if (!id || loading || messages.length === 0) return;
    emitPageFirstRender(id);
    for (const m of messages) {
      emitReceiptRendered({ messageId: m.id, channelId: id, workUnitId: m.workUnitId ?? null });
    }
  }, [id, loading, messages]);
  const [sending, setSending] = useState(false);
  const [replyTo, setReplyTo] = useState<ChannelMessage | null>(null);
  // #493：线程回复送达后的轻量「已送达/等待 agent」状态（wuId + 送达时刻；agent 响应或超时清除）
  const [awaitingAgent, setAwaitingAgent] = useState<{ wuId: string; since: number } | null>(null);
  // #528：频道工作面 4 份服务端状态收编 channelWorkStore（ADR 2026-08-31 数据面模式）——
  // 本页退回纯订阅者：REQ 需求集（vision §5.3，#394 起喂右栏 REQ 链路卡）/ #440 本频道 WU 全集
  // （阶段条 WU 数据本体；status_changed 全量快照直替 + 重连强刷在 store/sync 层）/
  // #443 端点派生建议 + #447 currentWuId（同响应同 slice；resolved = #488「已成功返回」台账的等价替代，
  // 缺键/false → ChannelWorkBar 占位保持加载态不误显空闲）
  const channelReqs = useChannelWorkStore(s => (id ? s.reqs[id] : undefined)) ?? EMPTY_REQS;
  const channelWus = useChannelWorkStore(s => (id ? s.wus[id] : undefined)) ?? EMPTY_WUS;
  const suggestionsSlice = useChannelWorkStore(s => (id ? s.suggestions[id] : undefined));
  const channelSuggestions = suggestionsSlice?.suggestions ?? EMPTY_SUGGESTIONS;
  const currentWuId = suggestionsSlice?.currentWuId ?? null;
  // #440：建议片 dismiss 台账（会话级，key = `ep:{wuId}:{suggestionId}`，同 key 不复活）+ 输入框 prefill 通道
  const [dismissedSuggestionKeys, setDismissedSuggestionKeys] = useState<Set<string>>(new Set());
  const [inputPrefill, setInputPrefill] = useState<{ text: string; nonce: number } | undefined>(undefined);
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
  // #533：messageId 随投影下发（后端 action-center 唯一派生点）——回复区/提升/chip 定位全消费它，
  // 前端不再从已加载消息反推（#483 类「提问掉出分页推不出」机制性消除）
  // #546：投影四种消费形状（待办列表 / wu→mid 映射 / 提升集+判定 / 定位查找）收口 needInputViewOf
  // 单源选择器（notificationStore 旁纯函数），本页退回订阅并渲染，口径变更只落选择器一处
  // F2（2026-09-16 性能体检）：订阅经 useNeedInputView——投影内容等值复用旧引用，
  // 他频道 status_changed 触发的 stateItems 整体替换不掀动本频道下游派生
  const { onEvent, onReconnect } = useWebSocketContext();
  const needInput = useNeedInputView(id);
  const { waitingWus, promotedQuestionIds, isWaitingForInput } = needInput;

  // #528：频道工作面实时接线（页面级单点，ref-count=1）——挂载打底三 slice、SSE 事件路由
  // （status_changed 全量直替 / requirement.* upsert / message_sent 标脏）、重连全 slice 强刷，
  // 全在 useChannelWorkStoreSync + channelWorkStore；本页不再持有手写订阅/防抖/重连对齐
  useChannelWorkStoreSync(id);

  // 决策 9（SSE 负载加深）：SSE 断线重连 → 受影响面一次性 refetch（无序号/校验机制）：
  // 消息面 refresh + #403 频道数据面三切片强刷（频道工作面三 slice 由 useChannelWorkStoreSync 承担；
  // #468：waitingWus 面已删——行动中心重拉由 NotificationBell 的 onReconnect 承担）
  useEffect(() => {
    return onReconnect(() => {
      void refresh();
      if (!id) return;
      const channelData = useChannelDataStore.getState();
      void channelData.ensureVocabulary(id, { maxAgeMs: 0 });
      void channelData.ensureCurrentPmo(id, { maxAgeMs: 0 });
      void channelData.ensureMembers(id, { maxAgeMs: 0 });
    });
  }, [onReconnect, refresh, id]);

  // #403 白捡触发器（ADR 决策 3，#528 边界 1 留页面）：requirement.created/updated 可能改变
  // current-pmo 派生 → 失效强刷（REQ 数据本体 upsert 与建议标脏已迁 channelWorkStore，此处只留 PMO 接线）
  useEffect(() => {
    if (!id) return;
    return onEvent(msg => {
      if (msg.event_type !== 'requirement.created' && msg.event_type !== 'requirement.updated') return;
      const req = parseRequirementPayload(msg.data);
      if (!req) return;
      // 负载带 channelId → 按频道过滤；缺省（防御）放行
      if (req.channelId && req.channelId !== id) return;
      useChannelDataStore.getState().invalidateCurrentPmo(id);
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

  // #533：「WU 当前提问消息」唯一派生点 = 后端 action-center（stateItems.messageId 随 waitingWus 投影
  // 下发）——前端反推（latestQuestionIdByWu / latestQuestionMessageOf）已删；缺省 → 不挂回复区/
  // 不提升/定位给可见反馈，全部 fail-closed 不回退推导。#546：映射本体在 needInputViewOf 产物上

  // #447（spec #441 收尾）：「频道当前工单」拣选唯一正本 = 后端建议端点 currentWuId
  // （前端静态映射 wuSuggestions 与 pickCurrentWu 本地副本已删，杜绝前后端口径分叉）。
  // 阶段条 WU 本体取自 channelWus；端点 id 命中不了本频道列表（时序 skew）→ null 不渲染（fail-closed 不编造）
  const currentWu = useMemo(
    () => channelWus.find(w => w.id === currentWuId) ?? null,
    [channelWus, currentWuId],
  );

  // 批次 D-2 项6（频道内闸门 1 击化）：工作条闸门动作写路径 #545 起内建于 WuGateActions
  // （gateWriter 双写落点含 channelWorkStore 快照 + 建议标脏，本页零接线）；
  // 状态变化另有 status_changed SSE 直替 + 建议重拉（currentWuId 重拣选）兜底

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
      // 状态回扫：子单建出 → 前置条件转假 → 片消失/更新（#528 边界 5：store 暴露即时重拉）
      if (id) void useChannelWorkStore.getState().refreshSuggestions(id);
    } catch (e) {
      setSuggestionActionError(suggestionActionErrorMessage(e));
    } finally {
      setSuggestionActionRunning(false);
    }
  }, [pendingSuggestionAction, id]);

  const pendingActionDef = pendingSuggestionAction ? getSuggestionAction(pendingSuggestionAction.id) : null;

  // #279（走查 F4）/#533：挂起 WU 的当前提问消息（后端下发 messageId）若是线程回复（agent 追问），
  // 提升到主流可见；promotedQuestionIds / isWaitingForInput 均为 needInputViewOf 产物（#546）

  // #285: agent 消息 inline-code 文件 chip 词表——#403 起读 channelDataStore（与 ChannelInput
  // 共享一份拉取；按 channelId 键控无跨频道串词表）；失败静默降级，不渲染 chip。
  // #547：订阅本体已下沉到 ChannelMessageItem（selector 自取），本页只保留拉取触发
  useEffect(() => {
    if (!id) return;
    void useChannelDataStore.getState().ensureVocabulary(id);
  }, [id]);

  // #285 AC4: 文件 chip 第一优先词表 = 各 agent 消息所属 WU 的产出/修改文件集
  // （distinct workUnitId 逐个拉一次并缓存；拿不到/为空 → 该 WU 降级候选集词表，行为不变）
  // #528：拉取纪律与缓存收编 channelWorkStore per-wuId slice（失败记 [] 不重试语义保留）
  const wuChangedFiles = useChannelWorkStore(s => s.wuChangedFiles);
  useEffect(() => {
    const wuIds = [...new Set(
      messages.filter(m => m.authorType === 'agent' && m.workUnitId).map(m => m.workUnitId!),
    )];
    useChannelWorkStore.getState().ensureWuChangedFiles(wuIds);
  }, [messages]);

  // #416：右栏消息摘要投影——右栏只消费 card/agent WU 条目集（不再收全量 messages）；
  // 无关增量（人类插话等）投影等值 → 引用保持 → memo 化的右栏整栏零重渲
  const activityMessageItems = useActivityMessageItems(messages);

  // #530：定位语义（翻页定位循环 / 展开收起线程 / unpin / 高亮生命周期 / 防重入台账）
  // 已收编 useMessageLocate——quote / chip / ?highlight 三条调用链见组合层产物下方接线

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

  // #531：消息流组合层——「messages 到手之后到渲染之前」的全部装配内化 useChannelStream
  // （deriveStreamView → messageToItemIndex → streamHead 测量 → useStreamFollow → syncPruning
  // 的接线顺序不变量由模块结构承载）；本页只消费契约产物：结构（头块/导航）、滚动跟随
  // （浮钮/发送链路）、特性消费产物（下方 locate / 键盘导航即插即用口）
  const stream = useChannelStream({
    channelId: id,
    messages, loading, loadMore, syncPruning,
    promotedQuestionIds, isWaitingForInput,
  });
  const {
    streamHeadRef, completedCount, showCompleted, setShowCompleted,
    streamRef, handleStreamScroll, showJumpToBottom, pinAndJumpToBottom, unpinFromBottom,
    awayNewCount, handleLoadMore, ownSendPendingRef,
    messageToItemIndex, virtualizer, virtualEnabled, setCollapsedThreads,
  } = stream;

  // #530：mid→可见 定位语义单入口（架构评审 2026-09-14 候选 2）——翻页定位循环（#439）/
  // 根锚解析展开收起线程 / unpin 时机 / 高亮生命周期（滚动 + 2s 消退）/ 防重入台账全内化模块；
  // 三条调用链全部退化为 locate(mid)：quote 与 reply 预览直传（见 renderMessageItem / ChannelInput）、
  // chip 定位用后端下发 messageId（#533）、?highlight 直达
  const { highlightId, locate: locateMessage } = useMessageLocate({
    messages, hasMore, loadMore,
    setCollapsedThreads,
    unpinFromBottom,
    streamRef, virtualizer, virtualEnabled, messageToItemIndex,
  });

  // #279（决策 #250 D4）/ #533：chip 点条目 → 定位后端下发的提问 messageId（wu→mid 不再前端反推）；
  // messageId 缺省（fail-closed）→ toast 可见反馈，不静默不翻页
  const locateWaitingQuestion = useCallback((wuId: string) => {
    const mid = needInput.questionIdByWu.get(wuId);
    if (!mid) {
      toast.warning('提问消息缺少定位锚点，无法定位');
      return;
    }
    locateMessage(mid);
  }, [needInput, locateMessage]);

  // 通知中心点击直达（?highlight=<mid>）：每个 mid 只消费一次（防消息流更新反复重置高亮）；
  // 首拉未完成（loading）时等下一轮（防空列表误判不可达）。定位动作本体（含翻页/toast 兜底）在模块内
  const [searchParams] = useSearchParams();
  const highlightConsumedRef = useRef<string | null>(null);
  useEffect(() => {
    const mid = searchParams.get('highlight');
    if (!mid || highlightConsumedRef.current === mid) return;
    if (loading) return;
    highlightConsumedRef.current = mid;
    locateMessage(mid);
  }, [searchParams, loading, locateMessage]);

  // Phase 3（AC5）：消息级键盘导航（j/k/r/Esc）——可导航序列 = stream items 拍平
  // （navigableIdsOf 纯函数：折叠组/日期分隔跳过）；滚动跟随 scrollToIndex 优先、DOM 查询兜底
  const navIds = useMemo(() => navigableIdsOf(stream.items), [stream.items]);
  const scrollToFocusedMessage = useCallback((mid: string) => {
    unpinFromBottom(); // 键盘导航 = 离开底部的阅读意图（同 highlight 定位，防钉底跟随拽回）
    const idx = messageToItemIndex.get(mid);
    if (virtualEnabled && idx != null) virtualizer.scrollToIndex(idx, { align: 'auto' });
    const el = streamRef.current?.querySelector(`[data-message-id="${mid}"]`);
    (el as HTMLElement | null)?.scrollIntoView?.({ block: 'nearest' }); // jsdom 无实现，?. 兜底
  }, [unpinFromBottom, messageToItemIndex, virtualEnabled, virtualizer, streamRef]);
  const focusComposer = useCallback(() => {
    // ChannelInput 未暴露 imperative focus——经既有根类查询其 textarea（DOM 查询先例见 highlight effect）
    setTimeout(() => document.querySelector<HTMLTextAreaElement>('.mc-inputbar textarea')?.focus(), 0);
  }, []);
  const handleNavReply = useCallback((mid: string) => {
    const m = findMessage(mid);
    if (!m) return; // 焦点 id 掉出已加载集（时序防御）→ 不起回复
    handleReply(m);
    focusComposer();
  }, [findMessage, handleReply, focusComposer]);
  const { focusedId } = useMessageNav({
    navIds,
    onReply: handleNavReply,
    hasReplyTo: replyTo !== null,
    onCancelReply: () => setReplyTo(null), // 内联回调：hook 镜像 ref 每渲染同步，引用稳定非必需
    onFocusScroll: scrollToFocusedMessage,
  });

  const handleSend = useCallback(async (content: string, replyToId?: string, files?: FileRef[]) => {
    setSending(true);
    // 标记「自己发送」窗口：消息落地（本 effect 链或 SSE 先去重）时跟随分支消费并清除
    ownSendPendingRef.current = true;
    try {
      // #281: files 仅在有文件引用时透传（保旧调用两参形态）
      const sent = files?.length
        ? await sendMessage(content, replyToId, files)
        : await sendMessage(content, replyToId);
      setReplyTo(null);
      // #493：线程回复送达且命中 WU（workUnitId 继承成功 = 会触达 agent）→ 轻量「已送达/等待 agent」状态
      if (replyToId && sent?.workUnitId) setAwaitingAgent({ wuId: sent.workUnitId, since: Date.now() });
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

  // #493：「等待 agent」状态条——agent 已响应（该 WU 的 agent 新消息到达）即 render 派生隐藏，
  // 不做 effect 内同步 setState；state 本体由 30s 兜底定时器清理（agent 无响应时条不常住；
  // 30s 口径 > 唤醒+认领秒级路径，loop 异常时由工作条/建议片承接下来）
  // #548：判定本体迁出页面——agentAnsweredOf（channelMessageStore 旁挂纯函数），本页只消费派生结果
  const agentAnswered = agentAnsweredOf(messages, awaitingAgent);
  useEffect(() => {
    if (!awaitingAgent) return;
    const timer = setTimeout(() => setAwaitingAgent(null), 30_000);
    return () => clearTimeout(timer);
  }, [awaitingAgent]);

  // 批次 E-3：SSE 新到达消息渐隐高亮（白名单③状态色切换：accent-dim 底色 → 常态，仅 background-color 过渡）。
  // 口径 = 全部新到达消息（含自己发送的回显——消息模型只有 authorType 无 authorId，区分不到个人，
  // 与 useStreamFollow ownSendPending 窗口同一局限）；首拉与翻页 prepend/水合归并的历史不标
  // （createdAt 早于到达前最新一条即历史）。2s 后移类，经 .mc-msg 基类过渡渐隐
  // #548：判定本体迁出页面——useFreshMessageIds（hooks/），本页只消费派生集合
  const freshMsgIds = useFreshMessageIds(messages);

  // #547：频道消息环境——横切值单 Provider 下发，消息项 useContext 自取（公开 Props 收窄）。
  // #322 契约不变量：成员全为稳定引用（useCallback/镜像 ref），useMemo 组装后 value identity
  // 不随页面重渲变化 → context 零扇出；highlightId/focusedId/freshMsgIds 等 volatile state 禁入
  const messageEnv = useMemo<ChannelMessageEnv>(() => ({
    onAction: handleAction,
    onReply: handleReply,
    findMessage,
    channelId: id,
    onOpenWorkUnit: openWu,
    onOpenWorkUnitConfirm: openWuConfirm,
    onOpenWorkUnitRuling: openWuRuling,
    onOpenRequirement: openReq,
    onInlineReply: handleInlineReply,
    onQuoteClick: locateMessage,
  }), [handleAction, handleReply, findMessage, id, openWu, openWuConfirm, openWuRuling, openReq, handleInlineReply, locateMessage]);

  // #322：提升为 useCallback——消除每次渲染新建的内联 render props（memo 稳定 props 契约）
  // #547：手喂面收窄到 message + 5 个 per-message 派生值（共 6 个）；横切值经 messageEnv 下发，
  // 结构 props 经 ChannelStreamBody 封闭 extra（StreamMessageExtra）喂入
  const renderMessageItem = useCallback((msg: ChannelMessage, extra: StreamMessageExtra = {}) => (
    <ChannelMessageItem
      key={msg.id}
      message={msg}
      waitingForInput={isWaitingForInput(msg)}
      wuChangedFiles={msg.workUnitId ? wuChangedFiles[msg.workUnitId] : undefined}
      highlight={highlightId === msg.id}
      fresh={freshMsgIds.has(msg.id)}
      focused={focusedId === msg.id}
      {...extra}
    />
  ), [isWaitingForInput, wuChangedFiles, highlightId, freshMsgIds, focusedId]);

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
        <ChannelWorkBar channelId={id} currentWu={currentWu} onOpenWorkUnit={openWu} wuIdle={wuIdleOf(suggestionsSlice)} />

        {/* Message list
            #325：头部块（空态/加载更早/折叠 toggle）与消息体分离——
            头部高度经 streamHeadRef 量作 virtualizer scrollMargin（组合层内）；
            #531：消息体结构分支（virtual/non-virtual + spacer/translateY）在 ChannelStreamBody */}
        <div className="mc-stream" ref={streamRef} onScroll={handleStreamScroll}>
          {/* mc-stream-head：滚动测量容器（streamHeadRef 挂点），无样式需求，结构化 hook（#431 定性保留） */}
          <div className="mc-stream-head" ref={streamHeadRef}>
            {loading && messages.length === 0 && (
              // 批次 F-3：消息流首拉骨架（批次 E-2 ui/Skeleton 正本）——消息行形态
              <SkeletonText lines={5} widths={['40%', '65%', '55%', '70%', '45%']} className="space-y-4 p-4" />
            )}
            {!loading && error && messages.length === 0 && (
              // #482：首拉/兜底轮询失败——错误态 + 重试入口，与真空频道区分（原呈假空态，
              // 用户会把加载故障误判为空频道）；已有消息时轮询失败不整屏替换，消息流保留
              <div className="mc-stream-empty" role="alert">
                <p>消息加载失败</p>
                <button type="button" className="mc-empty-chip" onClick={() => { void refresh(); }}>重试</button>
              </div>
            )}
            {!loading && !error && messages.length === 0 && (
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
            {!showCompleted && completedCount > 2 && (
              <button onClick={() => setShowCompleted(true)} className="mc-collapse-toggle">
                显示 {completedCount - 2} 条已完成消息
              </button>
            )}
            {showCompleted && completedCount > 2 && (
              <button onClick={() => setShowCompleted(false)} className="mc-collapse-toggle">
                收起已完成消息
              </button>
            )}
          </div>
          {/* #531：items → DOM 结构分支（virtual/non-virtual + spacer/translateY + 三 kind 分派 +
              skeleton 占位）收编 ChannelStreamBody；renderMessageItem 与 highlightId 由本页注入 */}
          {/* #547：频道消息环境 Provider——横切值经 Context 下发到每条消息项（value 全稳定引用，见上方 useMemo） */}
          <ChannelMessageEnvProvider value={messageEnv}>
            <ChannelStreamBody stream={stream} renderMessage={renderMessageItem} highlightId={highlightId} />
          </ChannelMessageEnvProvider>
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

        {/* channel 上下游优化 Phase 4（AC6）：底部输入区视觉归组——引导片 / 送达反馈条 / 输入条
            收进统一容器（承载样式见 .mc-composer-stack），纯结构包裹，交互逻辑与状态流不动 */}
        <div className="mc-composer-stack">
          {/* #443–#447：引导片（唯一来源 = 建议端点派生片；prompt 点击填入输入框，status 只读，
              action 点击走上方确认弹窗直调确定性接口；会话级 dismiss）
              #484：片粒度 dismiss——每片独立 ✕，按片 dismissKey 记账，不再一键清全部 */}
          {visibleChips.length > 0 && (
            <SuggestionChips
              suggestions={visibleChips}
              onPick={(text) => setInputPrefill(p => ({ text, nonce: (p?.nonce ?? 0) + 1 }))}
              onAction={handleSuggestionAction}
              onDismiss={(item) => {
                const key = visibleChips.find(c => c.id === item.id)?.dismissKey;
                if (!key) return; // fail-closed：找不到台账 key 不记（不静默吞掉别片）
                setDismissedSuggestionKeys(prev => new Set(prev).add(key));
              }}
            />
          )}

          {/* #493：线程回复送达即时反馈——「已送达，等待 agent 响应」，
              该 WU 的 agent 新消息到达或 30s 超时自动消失 */}
          {awaitingAgent && !agentAnswered && (
            <div className="mc-agent-ack" role="status">已送达，等待 agent 响应…</div>
          )}

          {/* Input */}
          <ChannelInput onSend={handleSend} sending={sending} replyTo={replyTo} onCancelReply={() => setReplyTo(null)} channelId={id} prefill={inputPrefill} onReplyPreviewClick={locateMessage} />
        </div>
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
