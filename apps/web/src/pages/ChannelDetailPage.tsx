// Channel Detail Page — Mission Control 三栏（左频道栏 / 中对话流 / 右抽屉）
// 对话流逻辑与 B1-001/Phase 2 一致：日期分隔、已完成折叠、线程分组、NEED_INPUT 回复链路，零语义变更
import { useParams } from 'react-router-dom';
import { useEffect, useLayoutEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useChannelMessages } from '../hooks/useChannelEvents';
import { useChannelLiveExecutions } from '../hooks/useChannelLiveExecutions';
import { useWebSocketContext } from '../api/websocketHooks';
import { shortWuId } from '../utils/id';
import { ChannelMessageItem } from '../components/channel/ChannelMessageItem';
import { parseMeta } from '../utils/messageMeta';
import { isPinnedToBottom, isReaderScroll, shouldFollowBottom, captureFirstVisibleAnchor, anchorScrollDelta, type ScrollAnchor, type MessageRowRect } from '../utils/streamFollow';
import { loadReadingPosition, saveReadingPosition, type ReadingPosition } from '../utils/readingPosition';
import { deriveStreamView } from '../utils/streamView';
import { ChannelInput } from '../components/channel/ChannelInput';
import { ChannelMemberManager } from '../components/channel/ChannelMemberManager';
import { ChannelDefaultProjectSelect } from '../components/channel/ChannelDefaultProjectSelect';
import { ChannelCurrentPmoChip } from '../components/channel/ChannelCurrentPmoChip';
import { ChannelNeedInputChip, type NeedInputTodo } from '../components/channel/ChannelNeedInputChip';
import { ChannelRail } from '../components/channel/ChannelRail';
import { WorkUnitDrawer, type DrawerState } from '../components/channel/WorkUnitDrawer';
import { workunitApi } from '../api/workunit';
import { requirementApi, type Requirement, type RequirementStatus } from '../api/requirements';
import { parseLiveWuRef } from '../components/workunit/execution-rows';
import type { Channel, ChannelMessage, ChannelFileVocabulary, FileRef } from '../api/channel';
import { channelApi } from '../api/channel';
import { knowledgeApi } from '../api/knowledge';
import { memoryApi } from '../api/memory';
import { distillApi } from '../api/distill';
import { skillsApi } from '../api/skills';

/** #279（决策 #250 D4）：闸门类 WU 类型（人工验收单）——不聚合进 NEED_INPUT 待办 chip */
const GATE_WU_TYPES = new Set(['decision', 'spec']);

/**
 * WU（REST 全量或 status_changed 事件负载解析出的轻量引用）→ NEED_INPUT 待办条目。
 * 过滤逻辑：metadata.waitingForInput && 非闸门类；不满足 → null（调用方据此增/删列表项）。
 */
function needInputTodoOf(wu: { id: string; type?: string | null; scope?: string | null; metadata?: string | null }): NeedInputTodo | null {
  try {
    const md = JSON.parse(wu.metadata || '{}');
    if (!md.waitingForInput) return null;
    if (GATE_WU_TYPES.has(wu.type ?? '')) return null;
    return {
      wuId: wu.id,
      question: typeof md.waitingQuestion === 'string' ? md.waitingQuestion : undefined,
      scope: wu.scope ?? undefined,
    };
  } catch { return null; }
}

const REQ_STATUSES = new Set<RequirementStatus>(['open', 'in-progress', 'done', 'archived']);

/** requirement.created/updated SSE data → 轻量引用（坏数据 → null；channelId 可选，缺省由调用方放行） */
function parseRequirementRef(
  data: unknown,
): { id: string; channelId: string | null; title?: string; status?: RequirementStatus } | null {
  try {
    const p = (typeof data === 'string' ? JSON.parse(data) : data) as Record<string, unknown> | null;
    if (!p || typeof p !== 'object' || typeof p.id !== 'string') return null;
    return {
      id: p.id,
      channelId: typeof p.channelId === 'string' ? p.channelId : null,
      ...(typeof p.title === 'string' && p.title ? { title: p.title } : {}),
      ...(typeof p.status === 'string' && REQ_STATUSES.has(p.status as RequirementStatus)
        ? { status: p.status as RequirementStatus } : {}),
    };
  } catch {
    return null;
  }
}

export function ChannelDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [channel, setChannel] = useState<Channel | null>(null);
  const { messages, loading, sendMessage, loadMore, hasMore, refresh } = useChannelMessages(id);
  const [sending, setSending] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const [replyTo, setReplyTo] = useState<ChannelMessage | null>(null);
  // F5: NEED_INPUT 挂起中的 WorkUnit 集合（等待人类回复）；
  // #279（决策 #250 D4）：扩为对象集（chip 聚合要 WU 标识 + 问题摘要），闸门类（decision/spec）不聚合
  const [waitingWus, setWaitingWus] = useState<NeedInputTodo[]>([]);
  // REQ 需求编号（vision §5.3）：本频道需求 chips；全链路改右抽屉呈现
  const [channelReqs, setChannelReqs] = useState<Requirement[]>([]);
  // Mission Control 右抽屉：WorkUnit 详情 / REQ 全链路
  const [drawer, setDrawer] = useState<DrawerState>(null);
  // #242: 频道 live 执行状态条（本频道执行中 WU + 步号，SSE 驱动，点击开抽屉）
  const liveExecs = useChannelLiveExecutions(id ?? null);

  useEffect(() => {
    if (!id) return;
    channelApi.get(id).then(r => setChannel(r.data.data)).catch(() => {});
  }, [id]);

  // F5: 本频道挂起中的 WorkUnit（blocked + metadata.waitingForInput）——REST 打底 +
  // workunit.status_changed SSE 增量维护（SSE 负载深化 批 2 决策 5：摘 messages.length 依赖，wu 数据直取事件负载）。
  // #279：闸门类（decision/spec 人工验收单）不聚合进待办 chip（不阻塞执行，避免红点焦虑）；
  // waitingQuestion 供 chip 下拉问题摘要
  const { onEvent, onReconnect } = useWebSocketContext();

  // 具名打底函数（批 4 收尾对齐）：重连时与 messages.refresh 一并强制对齐（决策 9）
  const reloadWaitingWus = useCallback(() => {
    if (!id) return;
    workunitApi.list({ channelId: id, status: 'blocked', limit: 100 })
      .then(r => {
        setWaitingWus(r.data.data.flatMap(wu => {
          const todo = needInputTodoOf(wu);
          return todo ? [todo] : [];
        }));
      })
      .catch(() => {});
  }, [id]);

  const reloadChannelReqs = useCallback(() => {
    if (!id) return;
    requirementApi.list({ channelId: id })
      .then(r => setChannelReqs(r.data.data))
      .catch(() => {});
  }, [id]);

  // 决策 9（SSE 负载加深）：SSE 断线重连 → 受影响面一次性 refetch（无序号/校验机制）：
  // 消息面 refresh + waitingWus/REQ chips 两个打底面
  useEffect(() => {
    return onReconnect(() => { void refresh(); reloadWaitingWus(); reloadChannelReqs(); });
  }, [onReconnect, refresh, reloadWaitingWus, reloadChannelReqs]);

  useEffect(() => {
    reloadWaitingWus();
  }, [reloadWaitingWus]);

  useEffect(() => {
    if (!id) return;
    return onEvent(msg => {
      if (msg.event_type !== 'workunit.status_changed') return;
      const wu = parseLiveWuRef(msg.data);
      if (!wu || wu.channelId !== id) return;
      // 仍是 blocked 且满足过滤 → upsert；否则（迁出 blocked / waitingForInput 消失 / 变闸门类）→ 移除
      const todo = wu.status === 'blocked' ? needInputTodoOf(wu) : null;
      setWaitingWus(prev => {
        const idx = prev.findIndex(w => w.wuId === wu.id);
        if (!todo) return idx < 0 ? prev : prev.filter(w => w.wuId !== wu.id);
        if (idx < 0) return [...prev, todo];
        const next = [...prev];
        next[idx] = todo;
        return next;
      });
    });
  }, [id, onEvent]);

  // REQ 需求编号（vision §5.3）：本频道需求 chips；REST 打底（reloadChannelReqs，见上）+
  // requirement.created/updated SSE 增量（批 2 决策 6：摘 messages.length 依赖；事件负载含 id/channelId/title/status）
  useEffect(() => {
    reloadChannelReqs();
  }, [reloadChannelReqs]);

  useEffect(() => {
    if (!id) return;
    return onEvent(msg => {
      if (msg.event_type !== 'requirement.created' && msg.event_type !== 'requirement.updated') return;
      const ref = parseRequirementRef(msg.data);
      if (!ref) return;
      // 负载带 channelId → 按频道过滤；缺省（防御，旧桥未带）放行
      if (ref.channelId && ref.channelId !== id) return;
      if (msg.event_type === 'requirement.created') {
        // created 负载只有摘要字段，拉全量补进列表（updater 内按 id 去重）
        requirementApi.get(ref.id)
          .then(r => setChannelReqs(prev => (prev.some(x => x.id === ref.id) ? prev : [...prev, r.data.data])))
          .catch(() => {});
        return;
      }
      // updated：合并进已有条目；列表没有说明打底/created 未覆盖，交由重连 refetch（批 3 决策 9）
      setChannelReqs(prev => {
        const idx = prev.findIndex(r => r.id === ref.id);
        if (idx < 0) return prev;
        const next = [...prev];
        next[idx] = {
          ...prev[idx],
          ...(ref.title !== undefined ? { title: ref.title } : {}),
          ...(ref.status !== undefined ? { status: ref.status } : {}),
        };
        return next;
      });
    });
  }, [id, onEvent]);

  // 消息流滚动管理（仿 QQ/微信；#289 落地 dsh observed-top 台账方案）：
  // 打开定位最新；程序写 scrollTop 必记 observedTopRef 台账，scroll 事件偏离台账才算读者滚动；
  // 新消息仅在钉底中或自己发送时跟随；ResizeObserver 跟随卡片展开等撑高；离底浮出「回到底部」；
  // #290（清单 #22/#27）：加载更早走行锚点补偿（不依赖总高度差）；阅读位置按频道持久化（localStorage）
  const streamRef = useRef<HTMLDivElement>(null);
  const streamInnerRef = useRef<HTMLDivElement>(null);
  const scrollStateRef = useRef<{ initial: boolean; anchor: ScrollAnchor | null }>({ initial: true, anchor: null });
  // observed-top 台账：记录最近一次程序写入落地后的 scrollTop（记 clamp 后实际值）
  const observedTopRef = useRef<number | null>(null);
  // 钉底状态只由读者滚动改写（几何判定见 streamFollow 纯函数）
  const pinnedRef = useRef(true);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  // 「自己发送」挂起标记：发送动作到消息落地之间的窗口置位，跟随判定据此识别自己的消息
  // （消息模型只有 authorType 无 authorId，无法精确到人；窗口内他人 human 消息会被误判为自发，可接受）
  const ownSendPendingRef = useRef(false);
  // #290（清单 #27）：阅读位置存档按 channelId 懒读（useLayoutEffect 早于 useEffect，
  // 挂载首帧被动 effect 还没跑，存档读取放在恢复分支里同步进行）
  const restoreRef = useRef<{ channelId: string | undefined; pos: ReadingPosition | null | undefined } | null>(null);
  // 当前消息集所属频道（渲染期镜像）：快速连切 A→B→C 时 B 的存档 cleanup 可能面对 A 的消息，
  // 频道不符则不存档，防把 A 的阅读位置记到 B 头上（污染存档）
  const messagesChannelRef = useRef<string | undefined>(undefined);
  messagesChannelRef.current = messages[0]?.channelId;

  // 程序滚动统一入口：写入并记账
  const scrollStreamTo = useCallback((top: number) => {
    const el = streamRef.current;
    if (!el) return;
    el.scrollTop = top;
    observedTopRef.current = el.scrollTop;
  }, []);

  // 捕获首个可见消息行作锚点（视口相对坐标；几何判定走 streamFollow 纯函数）
  const captureAnchor = useCallback((): ScrollAnchor | null => {
    const el = streamRef.current;
    if (!el) return null;
    const containerTop = el.getBoundingClientRect().top;
    const rows: MessageRowRect[] = Array.from(el.querySelectorAll('[data-message-id]')).map(node => {
      const rect = node.getBoundingClientRect();
      return { mid: node.getAttribute('data-message-id')!, top: rect.top - containerTop, bottom: rect.bottom - containerTop };
    });
    return captureFirstVisibleAnchor(rows);
  }, []);

  // 锚行当前视口相对 top（找不到返回 null：锚消息被清理/未渲染）
  const anchorRowTop = useCallback((mid: string): number | null => {
    const el = streamRef.current;
    if (!el) return null;
    const row = el.querySelector(`[data-message-id="${mid}"]`);
    if (!row) return null;
    return row.getBoundingClientRect().top - el.getBoundingClientRect().top;
  }, []);

  const pinAndJumpToBottom = useCallback(() => {
    const el = streamRef.current;
    if (!el) return;
    pinnedRef.current = true;
    setShowJumpToBottom(false);
    scrollStreamTo(el.scrollHeight);
  }, [scrollStreamTo]);

  // scroll 事件归属判定：偏离台账才算读者滚动，读者滚动才改写钉底状态
  const handleStreamScroll = useCallback(() => {
    const el = streamRef.current;
    if (!el) return;
    if (isReaderScroll(el.scrollTop, observedTopRef.current)) {
      const pinned = isPinnedToBottom(el);
      pinnedRef.current = pinned;
      setShowJumpToBottom(!pinned);
    }
    // 无论归属都续记实际位置：浏览器 shrink-clamp / 延迟落地的程序滚动精确落在台账上
    observedTopRef.current = el.scrollTop;
  }, []);

  // 切换频道：下一批消息到达时按存档恢复阅读位置（无存档/钉底则定位底部）；
  // cleanup（切走/卸载，此时 DOM 仍是旧频道消息）存档旧频道阅读位置——钉底存 null，否则记首个可见行
  useEffect(() => {
    const currentId = id;
    scrollStateRef.current.initial = true;
    ownSendPendingRef.current = false;
    restoreRef.current = null; // 换频道强制重读存档（防复用上次恢复的残值）
    return () => {
      if (!currentId) return;
      // 消息仍属其他频道（快速连切，新频道数据未到达）→ 不存档
      if (messagesChannelRef.current && messagesChannelRef.current !== currentId) return;
      saveReadingPosition(currentId, pinnedRef.current ? null : captureAnchor());
    };
  }, [id, captureAnchor]);

  // #290（清单 #22）：行锚点补偿——记录首个可见消息行；失败/无更多时清锚点防视口乱跳
  const handleLoadMore = useCallback(async () => {
    scrollStateRef.current.anchor = captureAnchor();
    const prepended = await loadMore();
    if (!prepended) scrollStateRef.current.anchor = null;
  }, [loadMore, captureAnchor]);

  useLayoutEffect(() => {
    const el = streamRef.current;
    if (!el || messages.length === 0) return;
    const state = scrollStateRef.current;
    // 前插了更早的消息：按锚行位移校正，视口停留在原消息行（不依赖总高度差，抗加载期异步撑高）
    if (state.anchor) {
      const anchor = state.anchor;
      state.anchor = null;
      const newTop = anchorRowTop(anchor.mid);
      if (newTop !== null) scrollStreamTo(el.scrollTop + anchorScrollDelta(anchor.top, newTop));
      return;
    }
    // 初次加载完成：有阅读位置存档恢复锚行；无存档/钉底存档/锚行已不在则定位底部
    if (state.initial) {
      if (!loading) {
        state.initial = false;
        if (restoreRef.current?.channelId !== id) {
          restoreRef.current = { channelId: id, pos: id ? loadReadingPosition(id) : undefined };
        }
        const restore = restoreRef.current.pos;
        const restoreTop = restore ? anchorRowTop(restore.mid) : null;
        if (restore && restoreTop !== null) {
          pinnedRef.current = false;
          setShowJumpToBottom(true);
          scrollStreamTo(el.scrollTop + anchorScrollDelta(restore.top, restoreTop));
        } else {
          pinAndJumpToBottom();
        }
      }
      return;
    }
    // 新消息：钉底中或是自己发的，才跟随到底（他人的 human 消息不拽走阅读中的读者）
    const last = messages[messages.length - 1];
    const lastIsOwn = last?.authorType === 'human' && ownSendPendingRef.current;
    if (lastIsOwn) ownSendPendingRef.current = false;
    if (shouldFollowBottom(pinnedRef.current, lastIsOwn)) {
      pinAndJumpToBottom();
    }
  }, [messages, loading, scrollStreamTo, pinAndJumpToBottom, anchorRowTop]);

  // ResizeObserver 跟随：卡片展开/图片加载撑高内容、composer 撑高压缩视口时，钉底中则跟随
  useEffect(() => {
    const el = streamRef.current;
    const inner = streamInnerRef.current;
    if (!el || !inner || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (pinnedRef.current) scrollStreamTo(el.scrollHeight);
    });
    ro.observe(inner);
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollStreamTo]);

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
  }, [sendMessage]);

  // 统一卡片 action 路由（2026-07 知识审核闭环 / #101 角色记忆人审闸口）：按 action 分发。
  // knowledge_proposal approve → /knowledge-service/promote（draft→verified，参与注入）；
  // reject → /knowledge-service/demote（draft→archived）。
  // memory_proposal approve → /role-memory/promote（草稿→topic/索引）；reject → /role-memory/demote。
  // distill_proposal approve → /distill/approve（#143 蒸馏运行）；reject → /distill/reject（零副作用）。
  // gc_proposal approve → /distill/gc/approve（#144 GC 候选归档）；reject → /distill/gc/reject（零副作用）。
  // constraint_audit_proposal approve → /distill/audit/approve（#146 约束退役执行）；reject → /distill/audit/reject（零副作用）。
  // auditor_suggestion confirm/reject → POST /channels/:id/messages/:mid/card-decision（#278，采纳建未指派 task 工单；拒绝留痕）。
  // retract_confirm confirm/reject → POST /skills/:id/retract/decide（#278，confirm→deprecated / reject→published，卡片状态同步回写）。
  // 返回是否成功（卡片据此显示已审核状态）。
  const handleAction = useCallback(async (messageId: string, action: string): Promise<boolean> => {
    if (action === 'converted') { refresh(); return true; }
    // 卡片 meta 解析（三种提案卡共用；缺 cardData → null，各分支按缺数据返回 false）
    // #264：meta 双型兼容——线上为 object，存量/夹具为 string
    const cardDataOf = (): Record<string, any> | null => {
      const msg = messages.find(m => m.id === messageId);
      return parseMeta(msg?.meta).cardData ?? null;
    };
    if (action === 'knowledge_proposal_approve' || action === 'knowledge_proposal_reject') {
      const cardData = cardDataOf();
      const entries = cardData?.entries;
      const entryIds: string[] = Array.isArray(entries)
        ? entries
            .map((e: { id?: unknown }) => e?.id)
            .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
        : [];
      if (entryIds.length === 0) return false;
      const review = action === 'knowledge_proposal_approve'
        ? knowledgeApi.promote
        : knowledgeApi.demote;
      try {
        await Promise.all(entryIds.map(entryId => review(entryId)));
        refresh();
        return true;
      } catch {
        return false;
      }
    }
    if (action === 'memory_proposal_approve' || action === 'memory_proposal_reject') {
      const cardData = cardDataOf();
      const roleId = typeof cardData?.roleId === 'string' ? cardData.roleId : '';
      const entries = cardData?.entries;
      const entryIds: string[] = Array.isArray(entries)
        ? entries
            .map((e: { draftId?: unknown }) => e?.draftId)
            .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
        : [];
      if (!roleId || entryIds.length === 0) return false;
      const review = action === 'memory_proposal_approve'
        ? memoryApi.promote
        : memoryApi.demote;
      try {
        await review(roleId, entryIds);
        refresh();
        return true;
      } catch {
        return false;
      }
    }
    if (action === 'distill_proposal_approve' || action === 'distill_proposal_reject') {
      // #143 蒸馏提案：approve → /distill/approve；reject → /distill/reject（零副作用）
      const cardData = cardDataOf();
      const proposalId = typeof cardData?.proposalId === 'string' ? cardData.proposalId : '';
      if (!proposalId) return false;
      try {
        if (action === 'distill_proposal_approve') {
          const { data } = await distillApi.approve(proposalId);
          // 预算熔断（skipped）/ 执行失败 → 卡片保持待审（提案仍 pending，可重试）
          if (!data?.success) return false;
        } else {
          await distillApi.reject(proposalId);
        }
        refresh();
        return true;
      } catch {
        return false;
      }
    }
    if (action === 'gc_proposal_approve' || action === 'gc_proposal_reject') {
      // #144 GC 候选清单：approve → /distill/gc/approve（候选归档）；reject → /distill/gc/reject（零副作用）
      const cardData = cardDataOf();
      const gcProposalId = typeof cardData?.gcProposalId === 'string' ? cardData.gcProposalId : '';
      if (!gcProposalId) return false;
      try {
        if (action === 'gc_proposal_approve') {
          const { data } = await distillApi.gcApprove(gcProposalId);
          if (!data?.success) return false;
        } else {
          await distillApi.gcReject(gcProposalId);
        }
        refresh();
        return true;
      } catch {
        return false;
      }
    }
    if (action === 'constraint_audit_approve' || action === 'constraint_audit_reject') {
      // #146 存量约束审计：approve → /distill/audit/approve（retire 执行，可回滚）；reject → /distill/audit/reject（零副作用）
      const cardData = cardDataOf();
      const auditProposalId = typeof cardData?.auditProposalId === 'string' ? cardData.auditProposalId : '';
      if (!auditProposalId) return false;
      try {
        if (action === 'constraint_audit_approve') {
          const { data } = await distillApi.auditApprove(auditProposalId);
          if (!data?.success) return false;
        } else {
          await distillApi.auditReject(auditProposalId);
        }
        refresh();
        return true;
      } catch {
        return false;
      }
    }
    // #278（决策 #250 D2）：auditor_suggestion 卡接 card-decision 端点（human-only）。
    // 采纳 = 本频道建未指派 task 工单；拒绝 = 仅留痕。状态由后端回写 meta.status + SSE 推送。
    if (action === 'auditor_apply_confirm' || action === 'auditor_apply_reject') {
      if (!id) return false;
      try {
        await channelApi.cardDecision(id, messageId, action === 'auditor_apply_confirm' ? 'confirm' : 'reject');
        refresh();
        return true;
      } catch {
        return false;
      }
    }
    // #278（决策 #250 D2）：retract_confirm 卡接技能退役决策端点（confirm→deprecated / reject→published）。
    if (action === 'retract_confirm' || action === 'retract_reject') {
      const cardData = cardDataOf();
      const skillId = typeof cardData?.skillId === 'string' ? cardData.skillId : '';
      if (!skillId) return false;
      try {
        await skillsApi.retractDecide(skillId, action === 'retract_confirm' ? 'confirm' : 'reject', messageId);
        refresh();
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }, [id, messages, refresh]);

  const handleReply = useCallback((message: ChannelMessage) => {
    setReplyTo(message);
  }, []);

  // F5: NEED_INPUT 卡片内嵌回复 —— 与回复按钮同链路（sendMessage + replyToId）
  // #276（P2 #15）：返回 Promise——子组件 await 真实发送结果后才置位「已回复」（不发假承诺）
  const handleInlineReply = useCallback((message: ChannelMessage, content: string) => {
    return handleSend(content, message.id);
  }, [handleSend]);

  const findMessage = useCallback((msgId: string) => {
    return messages.find(m => m.id === msgId);
  }, [messages]);

  // F5: 挂起集合（由 waitingWus 派生）
  const waitingWuIds = useMemo(() => new Set(waitingWus.map(w => w.wuId)), [waitingWus]);

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

  // #285: agent 消息 inline-code 文件 chip 词表（channelId 变化时拉一次；失败静默降级，不渲染 chip）
  // 携带 channelId 防跨频道串词表（切换频道后旧词表不传给新频道）
  const [fileVocabulary, setFileVocabulary] = useState<{ channelId: string; data: ChannelFileVocabulary } | null>(null);
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await channelApi.getFileVocabulary(id);
        if (!cancelled && res.data?.data) setFileVocabulary({ channelId: id, data: res.data.data });
      } catch {
        // 静默降级：词表拿不到则 agent 正文维持纯文本现状
      }
    })();
    return () => { cancelled = true; };
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
      const entries = await Promise.all(pending.map(async (wuId): Promise<[string, string[]]> => {
        try {
          const res = await workunitApi.getChangedFiles(wuId);
          return [wuId, res.data?.data?.files ?? []];
        } catch {
          return [wuId, []]; // 静默降级：该 WU 走候选集词表
        }
      }));
      if (!cancelled) {
        setWuChangedFiles(prev => {
          const next = { ...prev };
          for (const [wuId, files] of entries) next[wuId] = files;
          return next;
        });
      }
    })();
    return () => { cancelled = true; };
  }, [messages]);

  // AC-C3: Thread expand/collapse state
  const [expandedThreads, setExpandedThreads] = useState<Set<string>>(new Set());
  // 线程内过程消息组的展开状态（默认折叠，key = proc-<首条消息 id>）
  const [expandedProcGroups, setExpandedProcGroups] = useState<Set<string>>(new Set());

  const toggleThread = useCallback((anchorId: string) => {
    setExpandedThreads(prev => {
      const next = new Set(prev);
      if (next.has(anchorId)) next.delete(anchorId);
      else next.add(anchorId);
      return next;
    });
  }, []);

  const toggleProcGroup = useCallback((key: string) => {
    setExpandedProcGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // #279（决策 #250 D4）：chip 点条目 → 滚动定位到该 WU 当前提问消息并高亮（2s 后消退）。
  // 提问消息若还埋在折叠线程里（数据时序边界），先把所属线程展开
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const locateWaitingQuestion = useCallback((wuId: string) => {
    const msgId = latestQuestionIdByWu.get(wuId);
    if (!msgId) return;
    const target = messages.find(m => m.id === msgId);
    if (target?.replyToId) {
      const anchorId = target.replyToId;
      setExpandedThreads(prev => new Set(prev).add(anchorId));
    }
    setHighlightId(msgId);
  }, [latestQuestionIdByWu, messages]);

  useEffect(() => {
    if (!highlightId) return;
    const el = streamRef.current?.querySelector(`[data-message-id="${highlightId}"]`);
    // jsdom 无 scrollIntoView 实现，?. 兜底
    (el as HTMLElement | null)?.scrollIntoView?.({ block: 'center' });
    const timer = setTimeout(() => setHighlightId(null), 2000);
    return () => clearTimeout(timer);
  }, [highlightId]);

  // 里程碑判定（不折叠）：人类消息 / 卡片消息 / 等待回复 / 最后一条回复——已迁入 deriveStreamView（#322）

  const openWu = useCallback((wuId: string) => setDrawer({ kind: 'wu', id: wuId }), []);
  // #284（决策 #250 D6）：analysis_confirm 接力卡「去确认」——打开即弹确认对话框
  const openWuConfirm = useCallback((wuId: string) => setDrawer({ kind: 'wu', id: wuId, autoApprove: true }), []);
  const openReq = useCallback((reqId: string) => setDrawer({ kind: 'req', id: reqId }), []);

  // #322: 消息流管线——归组/过程折叠/连续合并/日期分隔/可见性走 deriveStreamView 纯函数，
  // useMemo 消费（消息引用与 UI 状态不变则零重算）；折叠 UI 状态留组件
  const streamView = useMemo(() => deriveStreamView(messages, {
    showCompleted,
    expandedThreads,
    expandedProcGroups,
    promotedQuestionIds,
    isWaitingForInput,
  }), [messages, showCompleted, expandedThreads, expandedProcGroups, promotedQuestionIds, isWaitingForInput]);

  if (!id) return <div className="mc-stream-empty" style={{ height: '100%' }}>Invalid channel</div>;

  const renderMessageItem = (msg: ChannelMessage, extra: Partial<Parameters<typeof ChannelMessageItem>[0]> = {}) => (
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
      onOpenRequirement={openReq}
      onInlineReply={handleInlineReply}
      fileVocabulary={fileVocabulary && fileVocabulary.channelId === id ? fileVocabulary.data : undefined}
      wuChangedFiles={msg.workUnitId ? wuChangedFiles[msg.workUnitId] : undefined}
      highlight={highlightId === msg.id}
      {...extra}
    />
  );

  return (
    <div className="mc-ws">
      {/* 左栏：频道列表 + Agent 状态 */}
      <ChannelRail activeChannelId={id} />

      {/* 中栏：对话流 */}
      <main className="mc-main">
        <div className="mc-topbar">
          <h1 className="mc-topbar-name">#{channel?.name || id.slice(0, 8)}</h1>
          <span className="mc-topbar-type">
            {channel?.type === 'rnd' ? '研发频道' : channel?.type === 'decision' ? '决策频道' : '系统频道'}
          </span>
          <div className="mc-topbar-actions">
            {/* #279（决策 #250 D4）：NEED_INPUT 待办 chip（只聚合等待回复，闸门类不聚合） */}
            <ChannelNeedInputChip items={waitingWus} onLocate={locateWaitingQuestion} />
            {/* #272（决策 #251 Q6）：当前 PMO chip（派生不落库，点击跳项目页） */}
            <ChannelCurrentPmoChip channelId={id} />
            <ChannelMemberManager channelId={id} membersJson={channel?.members} />
            {/* #272（决策 #251 Q2'）：默认工程 = 本地 repo 下拉（落 defaultPath）；
                默认执行机器（远程 Workspace）挪设置区由 #286 承接 */}
            <ChannelDefaultProjectSelect
              channelId={id}
              defaultPath={channel?.defaultPath}
            />
          </div>
        </div>

        {/* #242: live 执行状态条——有 WU 执行中时显示，点击打开对应 WU 抽屉（过程明细仍在抽屉） */}
        {liveExecs.length > 0 && (
          <div className="mc-livebars">
            <div className="mc-livebars-inner">
              {liveExecs.map(e => (
                <button
                  key={e.workUnitId}
                  className="mc-livebar"
                  onClick={() => openWu(e.workUnitId)}
                  title={`打开 ${e.workUnitId} 执行详情`}
                >
                  <span className="mc-status mc-status-running"><span className="mc-dot" />执行中</span>
                  <span>
                    {shortWuId(e.workUnitId)} 正在执行
                    {e.step !== undefined ? ` · 第 ${e.step} 步` : ''}
                    {e.action ? ` · ${e.action}` : ''}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* REQ 需求编号 chips（vision §5.3）— 点击打开右抽屉全链路 */}
        {channelReqs.length > 0 && (
          <div className="mc-reqs">
            <span className="mc-reqs-label">REQ</span>
            {channelReqs.map(req => (
              <button
                key={req.id}
                onClick={() => openReq(req.id)}
                className="mc-req-chip"
                title={`${req.id} · ${req.title} · ${req.status}`}
              >
                {req.id} · {req.title} · <span className="mc-req-status">{req.status}</span>
              </button>
            ))}
          </div>
        )}

        {/* Message list */}
        <div className="mc-stream" ref={streamRef} onScroll={handleStreamScroll}>
          <div className="mc-stream-inner" ref={streamInnerRef}>
            {loading && messages.length === 0 && (
              <div className="mc-stream-empty">加载中…</div>
            )}
            {!loading && messages.length === 0 && (
              <div className="mc-stream-empty">
                <p>发送消息开始对话</p>
                <p>@Agent 提及 Agent 创建任务</p>
              </div>
            )}

            {/* B2-002: Load more */}
            {hasMore && (
              <button onClick={handleLoadMore} className="mc-loadmore">
                加载更早的消息
              </button>
            )}

            {/* B2-002: Date separators + B2-006: collapse completed + AC-C3: threads
                #322: 归组/折叠/合并/日期分隔/可见性由 deriveStreamView 算出（useMemo 消费） */}
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
            {streamView.items.map(item => {
              if (item.kind === 'thread') {
                const anchorId = item.anchor.id;
                return (
                  <div key={anchorId}>
                    {item.showDate && (
                      <div className="mc-date" key={item.dateKey}>
                        {item.dateLabel}
                      </div>
                    )}
                    {renderMessageItem(item.anchor, {
                      isThreadAnchor: true,
                      threadReplyCount: item.replyCount,
                      isExpanded: item.expanded,
                      onToggleThread: () => toggleThread(anchorId),
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
                  </div>
                );
              }
              return (
                <div key={item.message.id}>
                  {item.showDate && (
                    <div className="mc-date" key={item.dateKey}>
                      {item.dateLabel}
                    </div>
                  )}
                  {renderMessageItem(item.message, { compact: item.compact })}
                </div>
              );
            })}
          </div>
          {/* #289: 偏离底部时浮出「回到底部」（sticky 贴滚动视口底部，不占流内高度） */}
          {showJumpToBottom && (
            <div className="mc-jump-wrap">
              <button type="button" className="mc-jump-bottom" onClick={pinAndJumpToBottom}>
                ↓ 回到底部
              </button>
            </div>
          )}
        </div>

        {/* Input */}
        <ChannelInput onSend={handleSend} sending={sending} replyTo={replyTo} onCancelReply={() => setReplyTo(null)} channelId={id} />
      </main>

      {/* 右栏：抽屉（WorkUnit 详情 / REQ 全链路） */}
      <WorkUnitDrawer
        drawer={drawer}
        onClose={() => setDrawer(null)}
        onOpenWu={openWu}
        onOpenReq={openReq}
      />
    </div>
  );
}
