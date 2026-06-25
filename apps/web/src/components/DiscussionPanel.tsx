// DiscussionPanel — WorkUnit 讨论空间（MVP-4）
import { useState, useEffect, useRef } from 'react';
import { workunitApi } from '../api/workunit';

interface Message {
  id: string;
  content: string;
  authorType: string;
  agentName?: string;
  createdAt: string;
}

export function DiscussionPanel({ workUnitId }: { workUnitId: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const loadMessages = async () => {
    setLoading(true);
    try {
      const { data } = await workunitApi.getMessages(workUnitId);
      const resp = data as { data?: Message[] } | Message[];
      setMessages(Array.isArray(resp) ? resp : resp?.data ?? []);
    } catch (e) {
      console.error('Failed to load messages:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadMessages();
  }, [workUnitId]);

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || sending) return;
    setSending(true);
    try {
      await workunitApi.postMessage(workUnitId, input.trim(), 'human');
      setInput('');
      await loadMessages();
    } catch (e) {
      console.error('Failed to send message:', e);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mt-2 rounded" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)' }}>
      <div className="px-3 py-2 text-xs font-medium" style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-subtle)' }}>
        讨论空间
      </div>

      <div ref={listRef} className="max-h-48 overflow-auto px-3 py-2 space-y-2">
        {loading && messages.length === 0 ? (
          <div className="text-xs text-gray-500">加载中...</div>
        ) : messages.length === 0 ? (
          <div className="text-xs text-gray-500">暂无消息</div>
        ) : (
          messages.map(msg => (
            <div key={msg.id} className="text-xs">
              <span className={`font-medium ${msg.authorType === 'agent' ? 'text-purple-400' : 'text-blue-400'}`}>
                {msg.authorType === 'agent' ? (msg.agentName || 'Agent') : 'Human'}
              </span>
              <span className="text-gray-500 ml-2">
                {new Date(msg.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
              </span>
              <div className="mt-0.5 text-gray-300 whitespace-pre-wrap">{msg.content}</div>
            </div>
          ))
        )}
      </div>

      <div className="flex gap-2 px-3 py-2" style={{ borderTop: '1px solid var(--border-subtle)' }}>
        <input
          className="flex-1 px-2 py-1 text-xs rounded bg-gray-800 text-white border border-gray-600 outline-none focus:border-blue-500"
          placeholder="输入消息..."
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSend()}
          disabled={sending}
        />
        <button
          className="text-xs px-2 py-1 rounded bg-blue-500/20 text-blue-300 hover:bg-blue-500/30 disabled:opacity-50"
          onClick={handleSend}
          disabled={sending || !input.trim()}
        >
          {sending ? '...' : '发送'}
        </button>
      </div>
    </div>
  );
}
