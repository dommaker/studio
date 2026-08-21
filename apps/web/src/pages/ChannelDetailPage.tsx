// Channel Detail Page — Mission Control 三栏（左频道栏 / 中对话流 / 右抽屉）
// 对话流逻辑与 B1-001/Phase 2 一致：日期分隔、已完成折叠、线程分组、NEED_INPUT 回复链路，零语义变更
import { useParams } from 'react-router-dom';
import { useEffect, useLayoutEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useChannelMessages } from '../hooks/useChannelEvents';
import { useChannelLiveExecutions } from '../hooks/useChannelLiveExecutions';
import { shortWuId } from '../utils/id';
import { ChannelMessageItem } from '../components/channel/ChannelMessageItem';
import { parseMeta } from '../utils/messageMeta';
import { isPinnedToBottom, isReaderScroll, shouldFollowBottom } from '../utils/streamFollow';
import { ChannelInput } from '../components/channel/ChannelInput';
import { ChannelMemberManager } from '../components/channel/ChannelMemberManager';
import { ChannelDefaultProjectSelect } from '../components/channel/ChannelDefaultProjectSelect';
import { ChannelCurrentPmoChip } from '../components/channel/ChannelCurrentPmoChip';
import { ChannelNeedInputChip, type NeedInputTodo } from '../components/channel/ChannelNeedInputChip';
import { ChannelRail } from '../components/channel/ChannelRail';
import { WorkUnitDrawer, type DrawerState } from '../components/channel/WorkUnitDrawer';
import { workunitApi } from '../api/workunit';
import { requirementApi, type Requirement } from '../api/requirements';
import type { Channel, ChannelMessage, ChannelFileVocabulary, FileRef } from '../api/channel';
import { channelApi } from '../api/channel';
import { knowledgeApi } from '../api/knowledge';
import { memoryApi } from '../api/memory';
import { distillApi } from '../api/distill';
import { skillsApi } from '../api/skills';

function isToday(d: Date) {
  const now = new Date();
  return d.toDateString() === now.toDateString();
}
function isYesterday(d: Date) {
  const y = new Date();
  y.setDate(y.getDate() - 1);
  return d.toDateString() === y.toDateString();
}

/** AC-C3: Group messages into threads (anchor + replies)
 *  #279（走查 F4）：promoteIds 命中的线程回复提升到主流（agent 追问主流可见，不只在折叠线程里） */
interface ThreadGroup {
  anchor: ChannelMessage;
  replies: ChannelMessage[];
}

function groupIntoThreads(messages: ChannelMessage[], promoteIds?: Set<string>): Array<ChannelMessage | ThreadGroup> {
  const anchorMap = new Map<string, ThreadGroup>();
  const result: Array<ChannelMessage | ThreadGroup> = [];

  for (const msg of messages) {
    if (msg.workUnitId && !msg.replyToId) {
      // This is a thread anchor
      const group: ThreadGroup = { anchor: msg, replies: [] };
      anchorMap.set(msg.id, group);
      result.push(group);
    } else if (msg.replyToId && anchorMap.has(msg.replyToId) && !promoteIds?.has(msg.id)) {
      // This is a thread reply
      anchorMap.get(msg.replyToId)!.replies.push(msg);
    } else {
      // Regular message (no thread)
      result.push(msg);
    }
  }

  return result;
}

/** 线程回复渲染项：单条消息，或被折叠的连续过程消息组 */
type ReplyItem =
  | { kind: 'msg'; msg: ChannelMessage }
  | { kind: 'group'; key: string; messages: ChannelMessage[] };

/**
 * #277（决策 #248 D2）：连续消息合并——同作者（authorType + agentName）5 分钟内、
 * 同线程/主流内、未参与折叠的连续消息省略重复头（Slack 式）。
 * 系统播报（Studio 署名无卡）与卡片消息不参与合并（既不并入别人，别人也不并入它）。
 */
const MERGE_WINDOW_MS = 5 * 60 * 1000;

/** #279（决策 #250 D4）：闸门类 WU 类型（人工验收单）——不聚合进 NEED_INPUT 待办 chip */
const GATE_WU_TYPES = new Set(['decision', 'spec']);

function mergeable(m: ChannelMessage): boolean {
  return !parseMeta(m.meta).cardType && !(m.authorType === 'agent' && m.agentName === 'Studio');
}

function shouldOmitHead(prev: ChannelMessage | null, cur: ChannelMessage): boolean {
  if (!prev || !mergeable(prev) || !mergeable(cur)) return false;
  if (prev.authorType !== cur.authorType || (prev.agentName ?? '') !== (cur.agentName ?? '')) return false;
  return new Date(cur.createdAt).getTime() - new Date(prev.createdAt).getTime() <= MERGE_WINDOW_MS;
}

/**
 * 线程内过程消息折叠/聚合：连续 ≥3 条「过程消息」收成一组（默认折叠，点击展开）。
 * 里程碑消息不折叠：人类消息、卡片消息、等待回复（NEED_INPUT）、最后一条回复（最新状态）。
 */
function collapseProcessReplies(
  replies: ChannelMessage[],
  isMilestone: (m: ChannelMessage, isLast: boolean) => boolean,
): ReplyItem[] {
  const items: ReplyItem[] = [];
  let run: ChannelMessage[] = [];
  const flush = () => {
    if (run.length >= 3) {
      items.push({ kind: 'group', key: `proc-${run[0].id}`, messages: run });
    } else {
      for (const m of run) items.push({ kind: 'msg', msg: m });
    }
    run = [];
  };
  replies.forEach((m, i) => {
    if (isMilestone(m, i === replies.length - 1)) {
      flush();
      items.push({ kind: 'msg', msg: m });
    } else {
      run.push(m);
    }
  });
  flush();
  return items;
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

  // F5: 拉取本频道挂起中的 WorkUnit（blocked + metadata.waitingForInput）
  // #279：闸门类（decision/spec 人工验收单）不聚合进待办 chip（不阻塞执行，避免红点焦虑）；
  // waitingQuestion 供 chip 下拉问题摘要
  useEffect(() => {
    if (!id) return;
    workunitApi.list({ channelId: id, status: 'blocked', limit: 100 })
      .then(r => {
        const waiting = r.data.data.flatMap(wu => {
          try {
            const md = JSON.parse(wu.metadata || '{}');
            if (!md.waitingForInput) return [];
            if (GATE_WU_TYPES.has(wu.type)) return [];
            return [{
              wuId: wu.id,
              question: typeof md.waitingQuestion === 'string' ? md.waitingQuestion : undefined,
              scope: wu.scope,
            }];
          } catch { return []; }
        });
        setWaitingWus(waiting);
      })
      .catch(() => {});
  }, [id, messages.length]);

  // REQ 需求编号（vision §5.3）：拉取本频道需求（派发会自动新建，随消息刷新）
  useEffect(() => {
    if (!id) return;
    requirementApi.list({ channelId: id })
      .then(r => setChannelReqs(r.data.data))
      .catch(() => {});
  }, [id, messages.length]);

  // 消息流滚动管理（仿 QQ/微信；#289 落地 dsh observed-top 台账方案）：
  // 打开定位最新；程序写 scrollTop 必记 observedTopRef 台账，scroll 事件偏离台账才算读者滚动；
  // 新消息仅在钉底中或自己发送时跟随；ResizeObserver 跟随卡片展开等撑高；离底浮出「回到底部」
  const streamRef = useRef<HTMLDivElement>(null);
  const streamInnerRef = useRef<HTMLDivElement>(null);
  const scrollStateRef = useRef({ initial: true, preserve: false, prevHeight: 0 });
  // observed-top 台账：记录最近一次程序写入落地后的 scrollTop（记 clamp 后实际值）
  const observedTopRef = useRef<number | null>(null);
  // 钉底状态只由读者滚动改写（几何判定见 streamFollow 纯函数）
  const pinnedRef = useRef(true);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  // 「自己发送」挂起标记：发送动作到消息落地之间的窗口置位，跟随判定据此识别自己的消息
  // （消息模型只有 authorType 无 authorId，无法精确到人；窗口内他人 human 消息会被误判为自发，可接受）
  const ownSendPendingRef = useRef(false);

  // 程序滚动统一入口：写入并记账
  const scrollStreamTo = useCallback((top: number) => {
    const el = streamRef.current;
    if (!el) return;
    el.scrollTop = top;
    observedTopRef.current = el.scrollTop;
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

  // 切换频道后，下一批消息到达时重新定位到底部
  useEffect(() => {
    scrollStateRef.current.initial = true;
    ownSendPendingRef.current = false;
  }, [id]);

  const handleLoadMore = useCallback(() => {
    const el = streamRef.current;
    if (el) {
      scrollStateRef.current.preserve = true;
      scrollStateRef.current.prevHeight = el.scrollHeight;
    }
    loadMore();
  }, [loadMore]);

  useLayoutEffect(() => {
    const el = streamRef.current;
    if (!el || messages.length === 0) return;
    const state = scrollStateRef.current;
    // 前插了更早的消息：按高度差补偿，视口停留在原消息
    if (state.preserve) {
      state.preserve = false;
      scrollStreamTo(el.scrollTop + (el.scrollHeight - state.prevHeight));
      return;
    }
    // 初次加载完成：直接定位到最新一条
    if (state.initial) {
      if (!loading) {
        state.initial = false;
        pinAndJumpToBottom();
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
  }, [messages, loading, scrollStreamTo, pinAndJumpToBottom]);

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

  // 里程碑判定（不折叠）：人类消息 / 卡片消息 / 等待回复 / 最后一条回复
  const isMilestoneReply = useCallback((m: ChannelMessage, isLast: boolean) => {
    if (isLast || m.authorType === 'human' || isWaitingForInput(m)) return true;
    return !!parseMeta(m.meta).cardType;
  }, [isWaitingForInput]);

  const openWu = useCallback((wuId: string) => setDrawer({ kind: 'wu', id: wuId }), []);
  // #284（决策 #250 D6）：analysis_confirm 接力卡「去确认」——打开即弹确认对话框
  const openWuConfirm = useCallback((wuId: string) => setDrawer({ kind: 'wu', id: wuId, autoApprove: true }), []);
  const openReq = useCallback((reqId: string) => setDrawer({ kind: 'req', id: reqId }), []);

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

            {/* B2-002: Date separators + B2-006: collapse completed + AC-C3: threads */}
            {(() => {
              const completed = messages.filter(m => {
                const status = parseMeta(m.meta).status;
                return typeof status === 'string' && ['done', 'confirmed', 'rejected', 'deprecated', 'error'].includes(status);
              });
              const active = messages.filter(m => !completed.includes(m));
              const visibleMessages = (showCompleted ? messages : [...active, ...completed.slice(-2)])
                .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

              // Re-group visible messages into threads（#279：当前提问消息提升主流，不进折叠线程）
              const items = groupIntoThreads(visibleMessages, promotedQuestionIds);

              // 每项（线程组取 anchor）的代表消息与日期串：日期分隔/合并判定均按可见项纯比较
              const itemMsgs = items.map(item => ('anchor' in item ? item.anchor : item));
              const itemDateStrs = itemMsgs.map(m =>
                new Date(m.createdAt).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' }));
              // #277 D2：主流连续合并（日期分隔线切断；线程组以其 anchor 参与主流序列）
              // #279：提升主流的当前提问消息不参与合并（badge/选项卡需要完整头，且不被前一条吃掉）
              const itemCompact = itemMsgs.map((m, idx) => {
                const showDate = idx === 0 || itemDateStrs[idx] !== itemDateStrs[idx - 1];
                if (promotedQuestionIds.has(m.id) || promotedQuestionIds.has(itemMsgs[idx - 1]?.id ?? '')) return false;
                return !showDate && shouldOmitHead(itemMsgs[idx - 1] ?? null, m);
              });

              const dateSep = (d: Date, dateStr: string, key: string) => (
                <div className="mc-date" key={key}>
                  {isToday(d) ? '今天' : isYesterday(d) ? '昨天' : dateStr}
                </div>
              );

              return (
                <>
                  {!showCompleted && completed.length > 2 && (
                    <button onClick={() => setShowCompleted(true)} className="mc-collapse-toggle">
                      显示 {completed.length - 2} 条已完成消息
                    </button>
                  )}
                  {showCompleted && completed.length > 2 && (
                    <button onClick={() => setShowCompleted(false)} className="mc-collapse-toggle">
                      收起已完成消息
                    </button>
                  )}
                  {items.map((item, idx) => {
                    if ('anchor' in item) {
                      // ThreadGroup
                      const msg = item.anchor;
                      const d = new Date(msg.createdAt);
                      const dateStr = d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
                      const showDate = idx === 0 || dateStr !== itemDateStrs[idx - 1];
                      const anchorId = msg.id;
                      const expanded = expandedThreads.has(anchorId);

                      return (
                        <div key={anchorId}>
                          {showDate && dateSep(d, dateStr, `date-${anchorId}`)}
                          {renderMessageItem(msg, {
                            isThreadAnchor: true,
                            threadReplyCount: item.replies.length,
                            isExpanded: expanded,
                            onToggleThread: () => toggleThread(anchorId),
                            compact: itemCompact[idx],
                          })}
                          {expanded && item.replies.length > 0 && (
                            <div className="mc-thread-replies">
                              {(() => {
                                // #277 D2：线程内同作者连续回复合并；折叠组切断合并，组内消息参与过折叠不省头
                                let prevReply: ChannelMessage | null = null;
                                return collapseProcessReplies(item.replies, isMilestoneReply).map(ri => {
                                  if (ri.kind === 'msg') {
                                    const compactReply = shouldOmitHead(prevReply, ri.msg);
                                    prevReply = ri.msg;
                                    return renderMessageItem(ri.msg, { isThreadReply: true, compact: compactReply });
                                  }
                                  prevReply = null;
                                  return expandedProcGroups.has(ri.key) ? (
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
                                });
                              })()}
                            </div>
                          )}
                        </div>
                      );
                    } else {
                      // Regular message
                      const msg = item;
                      const d = new Date(msg.createdAt);
                      const dateStr = d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
                      const showDate = idx === 0 || dateStr !== itemDateStrs[idx - 1];
                      return (
                        <div key={msg.id}>
                          {showDate && dateSep(d, dateStr, `date-${msg.id}`)}
                          {renderMessageItem(msg, { compact: itemCompact[idx] })}
                        </div>
                      );
                    }
                  })}
                </>
              );
            })()}
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
