// Channel Detail Page — B1-001
import { useParams, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useChannelMessages } from '../hooks/useChannelEvents';
import { ChannelMessageItem } from '../components/channel/ChannelMessageItem';
import { ChannelInput } from '../components/channel/ChannelInput';

function isToday(d: Date) {
  const now = new Date();
  return d.toDateString() === now.toDateString();
}
function isYesterday(d: Date) {
  const y = new Date();
  y.setDate(y.getDate() - 1);
  return d.toDateString() === y.toDateString();
}

export function ChannelDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [channel, setChannel] = useState<any>(null);
  const { messages, loading, sendMessage, sendAction, loadMore, hasMore } = useChannelMessages(id);
  const [sending, setSending] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);

  useEffect(() => {
    if (!id) return;
    api.get(`/channels/${id}`).then(r => setChannel(r.data.data)).catch(() => {});
  }, [id]);

  const handleSend = async (content: string) => {
    setSending(true);
    try {
      await sendMessage(content);
    } finally {
      setSending(false);
    }
  };

  const handleAction = (messageId: string, action: string) => {
    sendAction(messageId, action);
  };

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
            <p className="text-xs">输入 ≥30 字并包含 @Analyst 可触发需求分析</p>
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

        {/* B2-002: Date separators + B2-006: collapse completed */}
        {(() => {
          let lastDate = '';
          const completed = messages.filter(m => {
            try {
              const meta = JSON.parse(typeof m.meta === 'string' ? m.meta : '{}');
              return ['done', 'confirmed', 'rejected', 'deprecated', 'error'].includes(meta.status);
            } catch { return false; }
          });
          const active = messages.filter(m => !completed.includes(m));
          const display = showCompleted ? messages : [...active, ...completed.slice(-2)];

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
              {display.map(msg => {
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
                <ChannelMessageItem message={msg} onAction={handleAction} />
              </div>
            );
          })}
        </>)
        })()}
      </div>

      {/* Input */}
      <ChannelInput onSend={handleSend} sending={sending} />
    </div>
  );
}
