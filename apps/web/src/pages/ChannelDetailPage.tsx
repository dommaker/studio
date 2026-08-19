// Channel Detail Page — Mission Control 三栏（左频道栏 / 中对话流 / 右抽屉）
// 对话流逻辑与 B1-001/Phase 2 一致：日期分隔、已完成折叠、线程分组、NEED_INPUT 回复链路，零语义变更
import { useParams } from 'react-router-dom';
import { useEffect, useLayoutEffect, useState, useCallback, useRef } from 'react';
import { useChannelMessages } from '../hooks/useChannelEvents';
import { useChannelLiveExecutions } from '../hooks/useChannelLiveExecutions';
import { shortWuId } from '../utils/id';
import { ChannelMessageItem } from '../components/channel/ChannelMessageItem';
import { parseMeta } from '../utils/messageMeta';
import { ChannelInput } from '../components/channel/ChannelInput';
import { ChannelMemberManager } from '../components/channel/ChannelMemberManager';
import { ChannelDefaultProjectSelect } from '../components/channel/ChannelDefaultProjectSelect';
import { ChannelCurrentPmoChip } from '../components/channel/ChannelCurrentPmoChip';
import { ChannelRail } from '../components/channel/ChannelRail';
import { WorkUnitDrawer, type DrawerState } from '../components/channel/WorkUnitDrawer';
import { workunitApi } from '../api/workunit';
import { requirementApi, type Requirement } from '../api/requirements';
import type { Channel, ChannelMessage, ChannelFileVocabulary, FileRef } from '../api/channel';
import { channelApi } from '../api/channel';
import { knowledgeApi } from '../api/knowledge';
import { memoryApi } from '../api/memory';
import { distillApi } from '../api/distill';

function isToday(d: Date) {
  const now = new Date();
  return d.toDateString() === now.toDateString();
}
function isYesterday(d: Date) {
  const y = new Date();
  y.setDate(y.getDate() - 1);
  return d.toDateString() === y.toDateString();
}

/** AC-C3: Group messages into threads (anchor + replies) */
interface ThreadGroup {
  anchor: ChannelMessage;
  replies: ChannelMessage[];
}

function groupIntoThreads(messages: ChannelMessage[]): Array<ChannelMessage | ThreadGroup> {
  const anchorMap = new Map<string, ThreadGroup>();
  const result: Array<ChannelMessage | ThreadGroup> = [];

  for (const msg of messages) {
    if (msg.workUnitId && !msg.replyToId) {
      // This is a thread anchor
      const group: ThreadGroup = { anchor: msg, replies: [] };
      anchorMap.set(msg.id, group);
      result.push(group);
    } else if (msg.replyToId && anchorMap.has(msg.replyToId)) {
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
  // F5: NEED_INPUT 挂起中的 WorkUnit id 集合（等待人类回复）
  const [waitingWuIds, setWaitingWuIds] = useState<Set<string>>(new Set());
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
  useEffect(() => {
    if (!id) return;
    workunitApi.list({ channelId: id, status: 'blocked', limit: 100 })
      .then(r => {
        const waiting = r.data.data
          .filter(wu => {
            try { return !!JSON.parse(wu.metadata || '{}').waitingForInput; } catch { return false; }
          })
          .map(wu => wu.id);
        setWaitingWuIds(new Set(waiting));
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

  // 消息流滚动管理（仿 QQ/微信）：打开定位最新；新消息仅在人本就在底部附近或自己发送时跟随；加载更早保持视口
  const streamRef = useRef<HTMLDivElement>(null);
  const scrollStateRef = useRef({ initial: true, preserve: false, prevHeight: 0 });

  // 切换频道后，下一批消息到达时重新定位到底部
  useEffect(() => {
    scrollStateRef.current.initial = true;
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
      el.scrollTop = el.scrollTop + (el.scrollHeight - state.prevHeight);
      return;
    }
    // 初次加载完成：直接定位到最新一条
    if (state.initial) {
      if (!loading) {
        state.initial = false;
        el.scrollTop = el.scrollHeight;
      }
      return;
    }
    // 新消息：人在底部附近（≤80px）或是自己发的，才跟随到底
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 80;
    const last = messages[messages.length - 1];
    if (nearBottom || last?.authorType === 'human') {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, loading]);

  const handleSend = useCallback(async (content: string, replyToId?: string, files?: FileRef[]) => {
    setSending(true);
    try {
      // #281: files 仅在有文件引用时透传（保旧调用两参形态）
      if (files?.length) {
        await sendMessage(content, replyToId, files);
      } else {
        await sendMessage(content, replyToId);
      }
      setReplyTo(null);
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
    return false;
  }, [messages, refresh]);

  const handleReply = useCallback((message: ChannelMessage) => {
    setReplyTo(message);
  }, []);

  // F5: NEED_INPUT 卡片内嵌回复 —— 与回复按钮同链路（sendMessage + replyToId）
  const handleInlineReply = useCallback((message: ChannelMessage, content: string) => {
    void handleSend(content, message.id);
  }, [handleSend]);

  const findMessage = useCallback((msgId: string) => {
    return messages.find(m => m.id === msgId);
  }, [messages]);

  // F5: 消息关联的 WorkUnit 是否挂起等待回复
  const isWaitingForInput = useCallback((msg: ChannelMessage) => {
    return !!msg.workUnitId && waitingWuIds.has(msg.workUnitId);
  }, [waitingWuIds]);

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

  // 里程碑判定（不折叠）：人类消息 / 卡片消息 / 等待回复 / 最后一条回复
  const isMilestoneReply = useCallback((m: ChannelMessage, isLast: boolean) => {
    if (isLast || m.authorType === 'human' || isWaitingForInput(m)) return true;
    return !!parseMeta(m.meta).cardType;
  }, [isWaitingForInput]);

  const openWu = useCallback((wuId: string) => setDrawer({ kind: 'wu', id: wuId }), []);
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
      onOpenRequirement={openReq}
      onInlineReply={handleInlineReply}
      fileVocabulary={fileVocabulary && fileVocabulary.channelId === id ? fileVocabulary.data : undefined}
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
        <div className="mc-stream" ref={streamRef}>
          <div className="mc-stream-inner">
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

              // Re-group visible messages into threads
              const items = groupIntoThreads(visibleMessages);

              // 每项（线程组取 anchor）的代表消息与日期串：日期分隔/合并判定均按可见项纯比较
              const itemMsgs = items.map(item => ('anchor' in item ? item.anchor : item));
              const itemDateStrs = itemMsgs.map(m =>
                new Date(m.createdAt).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' }));
              // #277 D2：主流连续合并（日期分隔线切断；线程组以其 anchor 参与主流序列）
              const itemCompact = itemMsgs.map((m, idx) => {
                const showDate = idx === 0 || itemDateStrs[idx] !== itemDateStrs[idx - 1];
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
