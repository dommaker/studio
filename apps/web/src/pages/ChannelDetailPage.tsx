// Channel Detail Page — Mission Control 三栏（左频道栏 / 中对话流 / 右抽屉）
// 对话流逻辑与 B1-001/Phase 2 一致：日期分隔、已完成折叠、线程分组、NEED_INPUT 回复链路，零语义变更
import { useParams } from 'react-router-dom';
import { useEffect, useLayoutEffect, useState, useCallback, useRef } from 'react';
import { api } from '../api';
import { useChannelMessages } from '../hooks/useChannelEvents';
import { ChannelMessageItem } from '../components/channel/ChannelMessageItem';
import { ChannelInput } from '../components/channel/ChannelInput';
import { ChannelWorkspaceSetting } from '../components/ChannelWorkspaceSetting';
import { ChannelMemberManager } from '../components/channel/ChannelMemberManager';
import { ChannelRail } from '../components/channel/ChannelRail';
import { WorkUnitDrawer, type DrawerState } from '../components/channel/WorkUnitDrawer';
import { workunitApi } from '../api/workunit';
import { requirementApi, type Requirement } from '../api/requirements';
import type { ChannelMessage } from '../api/channel';

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
  const [channel, setChannel] = useState<any>(null);
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

  useEffect(() => {
    if (!id) return;
    api.get(`/channels/${id}`).then(r => setChannel(r.data.data)).catch(() => {});
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

  const handleSend = useCallback(async (content: string, replyToId?: string) => {
    setSending(true);
    try {
      await sendMessage(content, replyToId);
      setReplyTo(null);
    } finally {
      setSending(false);
    }
  }, [sendMessage]);

  // 统一卡片 action 路由（2026-07 知识审核闭环）：按 action 分发。
  // knowledge_proposal approve → /promote（draft→verified，参与注入）；
  // reject → /demote（draft→archived）。返回是否成功（卡片据此显示已审核状态）。
  const handleAction = useCallback(async (messageId: string, action: string): Promise<boolean> => {
    if (action === 'converted') { refresh(); return true; }
    if (action === 'knowledge_proposal_approve' || action === 'knowledge_proposal_reject') {
      const msg = messages.find(m => m.id === messageId);
      let entryIds: string[] = [];
      try {
        const meta = JSON.parse(typeof msg?.meta === 'string' ? msg.meta : '{}');
        const entries = meta?.cardData?.entries;
        if (Array.isArray(entries)) {
          entryIds = entries.map((e: any) => e?.id).filter((id: any) => typeof id === 'string' && id.length > 0);
        }
      } catch { entryIds = []; }
      if (entryIds.length === 0) return false;
      const endpoint = action === 'knowledge_proposal_approve'
        ? '/knowledge-service/promote'
        : '/knowledge-service/demote';
      try {
        await Promise.all(entryIds.map(entryId => api.post(endpoint, { entryId })));
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
    try {
      const meta = JSON.parse(typeof m.meta === 'string' ? m.meta : '{}');
      return !!meta.cardType;
    } catch {
      return false;
    }
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
            <ChannelMemberManager channelId={id} membersJson={channel?.members} />
            <ChannelWorkspaceSetting
              channelId={id}
              defaultWorkspaceId={channel?.defaultWorkspaceId}
            />
          </div>
        </div>

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
              let lastDate = '';
              const completed = messages.filter(m => {
                try {
                  const meta = JSON.parse(typeof m.meta === 'string' ? m.meta : '{}');
                  return ['done', 'confirmed', 'rejected', 'deprecated', 'error'].includes(meta.status);
                } catch { return false; }
              });
              const active = messages.filter(m => !completed.includes(m));
              const visibleMessages = (showCompleted ? messages : [...active, ...completed.slice(-2)])
                .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

              // Re-group visible messages into threads
              const items = groupIntoThreads(visibleMessages);

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
                  {items.map(item => {
                    if ('anchor' in item) {
                      // ThreadGroup
                      const msg = item.anchor;
                      const d = new Date(msg.createdAt);
                      const dateStr = d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
                      const showDate = dateStr !== lastDate;
                      lastDate = dateStr;
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
                          })}
                          {expanded && item.replies.length > 0 && (
                            <div className="mc-thread-replies">
                              {collapseProcessReplies(item.replies, isMilestoneReply).map(ri =>
                                ri.kind === 'msg' ? (
                                  renderMessageItem(ri.msg, { isThreadReply: true })
                                ) : expandedProcGroups.has(ri.key) ? (
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
                                )
                              )}
                            </div>
                          )}
                        </div>
                      );
                    } else {
                      // Regular message
                      const msg = item;
                      const d = new Date(msg.createdAt);
                      const dateStr = d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
                      const showDate = dateStr !== lastDate;
                      lastDate = dateStr;
                      return (
                        <div key={msg.id}>
                          {showDate && dateSep(d, dateStr, `date-${msg.id}`)}
                          {renderMessageItem(msg)}
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
