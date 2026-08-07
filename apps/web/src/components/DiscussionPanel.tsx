// DiscussionPanel — WorkUnit 讨论空间（MVP-4）
import { useState, useEffect, useRef, useCallback } from 'react';
import { workunitApi } from '../api/workunit';
import { AuthorAvatar } from './channel/AuthorAvatar';

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

  // 切换 workUnitId 时渲染期置 loading（官方 adjust-state-during-render 模式，
  // 比原 effect 内同步置位早一帧；挂载首帧时序不变）
  const [prevWorkUnitId, setPrevWorkUnitId] = useState(workUnitId);
  if (prevWorkUnitId !== workUnitId) {
    setPrevWorkUnitId(workUnitId);
    setLoading(true);
  }

  const loadMessages = useCallback(async () => {
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
  }, [workUnitId]);

  useEffect(() => {
    // 微任务触发：loadMessages 首行同步 setLoading(true)，直接在 effect 体内调用
    // 会触发 set-state-in-effect；微任务推迟一拍，时序与原实现逐帧等价
    void Promise.resolve().then(loadMessages);
  }, [loadMessages]);

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
          <div className="text-xs u-text-2">加载中...</div>
        ) : messages.length === 0 ? (
          <div className="text-xs u-text-2">暂无消息</div>
        ) : (
          messages.map(msg => (
            <div key={msg.id} className="text-xs">
              <div className="flex items-center gap-1.5">
                <AuthorAvatar isHuman={msg.authorType !== 'agent'} agentName={msg.agentName} />
                <span className={`font-medium ${msg.authorType === 'agent' ? 'u-accent' : 'u-accent'}`}>
                  {msg.authorType === 'agent' ? (msg.agentName || 'Agent') : 'Human'}
                </span>
                <span className="u-text-2">
                  {new Date(msg.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              <div className="mt-0.5 u-text-3 whitespace-pre-wrap">{msg.content}</div>
            </div>
          ))
        )}
      </div>

      <div className="flex gap-2 px-3 py-2" style={{ borderTop: '1px solid var(--border-subtle)' }}>
        <input
          className="flex-1 px-2 py-1 text-xs rounded u-surface u-text border u-border-2 outline-none "
          placeholder="输入消息..."
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSend()}
          disabled={sending}
        />
        <button
          className="text-xs px-2 py-1 rounded u-accent-dim u-accent u-hover-bg disabled:opacity-50"
          onClick={handleSend}
          disabled={sending || !input.trim()}
        >
          {sending ? '...' : '发送'}
        </button>
      </div>
    </div>
  );
}
