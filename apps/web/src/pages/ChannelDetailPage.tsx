// Channel Detail Page — B1-001 + Phase 2 (AC-C3 Thread rendering)
import { useParams, useNavigate } from 'react-router-dom';
import { useEffect, useState, useCallback } from 'react';
import { api } from '../api';
import { useChannelMessages } from '../hooks/useChannelEvents';
import { ChannelMessageItem } from '../components/channel/ChannelMessageItem';
import { ChannelInput } from '../components/channel/ChannelInput';
import { ChannelWorkspaceSetting } from '../components/ChannelWorkspaceSetting';
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

export function ChannelDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [channel, setChannel] = useState<any>(null);
  const { messages, loading, sendMessage, loadMore, hasMore, refresh } = useChannelMessages(id);
  const [sending, setSending] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const [replyTo, setReplyTo] = useState<ChannelMessage | null>(null);

  useEffect(() => {
    if (!id) return;
    api.get(`/channels/${id}`).then(r => setChannel(r.data.data)).catch(() => {});
  }, [id]);

  const handleSend = async (content: string, replyToId?: string) => {
    setSending(true);
    try {
      await sendMessage(content, replyToId);
      setReplyTo(null);
    } finally {
      setSending(false);
    }
  };

  const handleAction = useCallback((_messageId: string, action: string) => {
    if (action === 'converted') refresh();
  }, [refresh]);

  const handleReply = useCallback((message: ChannelMessage) => {
    setReplyTo(message);
  }, []);

  const findMessage = useCallback((msgId: string) => {
    return messages.find(m => m.id === msgId);
  }, [messages]);

  // AC-C3: Thread expand/collapse state
  const [expandedThreads, setExpandedThreads] = useState<Set<string>>(new Set());

  const toggleThread = useCallback((anchorId: string) => {
    setExpandedThreads(prev => {
      const next = new Set(prev);
      if (next.has(anchorId)) next.delete(anchorId);
      else next.add(anchorId);
      return next;
    });
  }, []);

  if (!id) return <div className="p-8 text-center text-gray-500">Invalid channel</div>;

  return (
    <div className="flex flex-col h-screen max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-200 bg-white">
        <button onClick={() => navigate('/channels')} className="text-gray-400 hover:text-gray-600">
          ←
        </button>
        <div>
          <h1 className="font-semibold text-gray-900">
            {channel?.name || `#${id.slice(0, 8)}`}
          </h1>
          <p className="text-xs text-gray-500">
            {channel?.type === 'rnd' ? '研发频道' : channel?.type === 'decision' ? '决策频道' : '系统频道'}
          </p>
        </div>
        <div className="ml-auto">
          <ChannelWorkspaceSetting
            channelId={id}
            defaultWorkspaceId={channel?.defaultWorkspaceId}
          />
        </div>
      </div>

      {/* Message list */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {loading && messages.length === 0 && (
          <div className="flex items-center justify-center h-full text-gray-400">
            加载中...
          </div>
        )}
        {!loading && messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-gray-400 text-sm">
            <p className="mb-2">发送消息开始对话</p>
            <p className="text-xs">@Agent 提及 Agent 创建任务</p>
          </div>
        )}

        {/* B2-002: Load more */}
        {hasMore && (
          <div className="text-center mb-4">
            <button
              onClick={loadMore}
              className="text-xs text-blue-500 hover:underline"
            >
              加载更早的消息
            </button>
          </div>
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

          return (
            <>
              {!showCompleted && completed.length > 2 && (
                <div className="text-center mb-3">
                  <button onClick={() => setShowCompleted(true)}
                    className="text-xs text-gray-400 hover:text-gray-600">
                    显示 {completed.length - 2} 条已完成消息
                  </button>
                </div>
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
                      {showDate && (
                        <div className="flex items-center gap-3 my-4">
                          <div className="flex-1 border-t border-gray-200" />
                          <span className="text-xs text-gray-400 flex-shrink-0">
                            {isToday(d) ? '今天' : isYesterday(d) ? '昨天' : dateStr}
                          </span>
                          <div className="flex-1 border-t border-gray-200" />
                        </div>
                      )}
                      <ChannelMessageItem
                        message={msg}
                        onAction={handleAction}
                        onReply={handleReply}
                        findMessage={findMessage}
                        channelId={id}
                        isThreadAnchor
                        threadReplyCount={item.replies.length}
                        isExpanded={expanded}
                        onToggleThread={() => toggleThread(anchorId)}
                      />
                      {expanded && item.replies.map(reply => (
                        <ChannelMessageItem
                          key={reply.id}
                          message={reply}
                          onAction={handleAction}
                          onReply={handleReply}
                          findMessage={findMessage}
                          channelId={id}
                          isThreadReply
                        />
                      ))}
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
                      {showDate && (
                        <div className="flex items-center gap-3 my-4">
                          <div className="flex-1 border-t border-gray-200" />
                          <span className="text-xs text-gray-400 flex-shrink-0">
                            {isToday(d) ? '今天' : isYesterday(d) ? '昨天' : dateStr}
                          </span>
                          <div className="flex-1 border-t border-gray-200" />
                        </div>
                      )}
                      <ChannelMessageItem message={msg} onAction={handleAction} onReply={handleReply} findMessage={findMessage} channelId={id} />
                    </div>
                  );
                }
              })}
            </>
          );
        })()}
      </div>

      {/* Input */}
      <ChannelInput onSend={handleSend} sending={sending} replyTo={replyTo} onCancelReply={() => setReplyTo(null)} channelId={id} />
    </div>
  );
}
