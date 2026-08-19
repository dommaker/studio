// Channel message input — AC-C1: @mention autocomplete + AC-C2: reply mode
// 2026-07 视觉重构（方向 A Mission Control）：mc-inputbar 视觉重绘；交互语义零变更
import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { channelApi, type AgentProfile, type ChannelMessage } from '../../api/channel';
import { useImeEnterGuard } from '../../hooks/useImeEnterGuard';

interface Props {
  onSend: (content: string, replyToId?: string) => void;
  sending: boolean;
  replyTo?: ChannelMessage | null;
  onCancelReply?: () => void;
  channelId?: string;
}

export function ChannelInput({ onSend, sending, replyTo, onCancelReply, channelId }: Props) {
  const [content, setContent] = useState('');
  // 光标位置由 onChange/onSelect 事件写入 state（渲染期禁读 ref）。
  // 顺带修复旧缺陷：原实现 memo 只依赖 content，光标点击移动不重算 mention 解析
  const [cursorPos, setCursorPos] = useState(0);
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [mentionIdx, setMentionIdx] = useState(0);
  // #270：Esc dismiss 状态——记录被 Esc 关掉的 mention 起点；继续输入（onChange）时复位。
  // 无此状态时弹框由残留 @query 推导永远关不掉，与「Esc 取消」提示矛盾。
  const [mentionDismissedAt, setMentionDismissedAt] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const activeMentionItemRef = useRef<HTMLButtonElement>(null);
  // #270：IME 合成守卫（isComposing / keyCode 229 / compositionend 后 10ms 兜底）
  const { handleCompositionEnd, isImeEvent } = useImeEnterGuard();

  // AC-B4: Fetch agents filtered by channel membership (falls back to all active if no channelId)
  useEffect(() => {
    channelApi.listAgents(channelId)
      .then(res => setAgents(res.data.data))
      .catch(() => setAgents([]));
  }, [channelId]);

  // Parse if we're in a mention: last @word before cursor
  const mentionState = useMemo(() => {
    const pos = Math.min(cursorPos, content.length);
    const before = content.slice(0, pos);
    const lastAt = before.lastIndexOf('@');
    if (lastAt === -1) return null;
    const query = before.slice(lastAt + 1);
    // Only show if there's no space after @ and before cursor
    if (query.includes(' ') || query.includes('\n')) return null;
    return { start: lastAt, query };
  }, [content, cursorPos]);

  const filteredAgents = useMemo(() => {
    if (!mentionState) return [];
    const q = mentionState.query.toLowerCase();
    return agents.filter(a => a.name.toLowerCase().includes(q));
  }, [mentionState, agents]);

  // #270：弹框可见性 = 有候选 且 未被 Esc dismiss（不再由残留 @query 单独推导）
  const popupOpen = filteredAgents.length > 0 && mentionDismissedAt !== mentionState?.start;

  // #270：弹框轻量重绘——选中项滚动进可视区（jsdom 无 scrollIntoView，?. 兜底）
  useEffect(() => {
    if (popupOpen) activeMentionItemRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [mentionIdx, popupOpen]);

  const insertMention = useCallback((agentName: string) => {
    if (!mentionState) return;
    const pos = Math.min(cursorPos, content.length);
    const before = content.slice(0, mentionState.start);
    const after = content.slice(pos);
    const newContent = `${before}@${agentName} ${after}`;
    const newCursor = mentionState.start + agentName.length + 2; // @name[space]
    setContent(newContent);
    setCursorPos(newCursor);
    setMentionIdx(0);
    // Set cursor after the inserted mention
    setTimeout(() => {
      const el = textareaRef.current;
      if (el) {
        el.setSelectionRange(newCursor, newCursor);
        el.focus();
      }
    }, 0);
  }, [content, cursorPos, mentionState]);

  const handleSend = () => {
    const trimmed = content.trim();
    if (!trimmed || sending) return;
    onSend(trimmed, replyTo?.id);
    setContent('');
    setCursorPos(0);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // #270：IME 选词中的 Enter 交给输入法，不选中候选、不发送（不 preventDefault）
    if (e.key === 'Enter' && isImeEvent(e)) return;
    // #270：Enter 长按（e.repeat）不连发、不连选；拦默认行为避免换行刷屏
    if (e.key === 'Enter' && e.repeat) {
      e.preventDefault();
      return;
    }
    // Mention popup keyboard navigation
    if (popupOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIdx(prev => (prev + 1) % filteredAgents.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIdx(prev => (prev - 1 + filteredAgents.length) % filteredAgents.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertMention(filteredAgents[mentionIdx].name);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        // #270：真正关闭弹框（dismiss 状态），与「Esc 取消」提示一致
        setMentionDismissedAt(mentionState?.start ?? null);
        setMentionIdx(0);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !popupOpen) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="mc-inputbar">
      <div className="mc-inputbar-inner">
        {/* Reply preview */}
        {replyTo && onCancelReply && (
          <div className="mc-input-reply">
            <span>↩</span>
            <span>
              回复 {replyTo.authorType === 'human' ? 'You' : replyTo.agentName || 'Agent'}:
            </span>
            <span className="mc-input-reply-content">{replyTo.content}</span>
            <button onClick={onCancelReply} className="mc-icon-btn" aria-label="取消回复">
              ✕
            </button>
          </div>
        )}

        <div className="mc-input-row">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={e => {
              setContent(e.target.value);
              setCursorPos(e.target.selectionStart ?? e.target.value.length);
              // #270：继续输入表达新意图，复位 Esc dismiss
              setMentionDismissedAt(null);
            }}
            onSelect={e => setCursorPos(e.currentTarget.selectionStart ?? e.currentTarget.value.length)}
            onKeyDown={handleKeyDown}
            onCompositionEnd={handleCompositionEnd}
            placeholder="输入消息，@Agent 提及 Agent..."
            rows={2}
            disabled={sending}
          />
          <button
            onClick={handleSend}
            disabled={sending || !content.trim()}
            className="mc-btn mc-btn-primary"
          >
            {sending ? '...' : '发送'}
          </button>
        </div>

        <div className="mc-input-hint">
          <span>{popupOpen ? '↑↓ 选择 Enter 确认 Esc 取消' : '@mention Agent · 回复引用 · Enter 发送'}</span>
          <span>{content.length} 字</span>
        </div>
      </div>

      {/* @mention popup */}
      {popupOpen && (
        <div className="mc-mention-popup" role="listbox" aria-label="提及 Agent 候选">
          {filteredAgents.map((agent, i) => (
            <button
              key={agent.id}
              ref={i === mentionIdx ? activeMentionItemRef : null}
              role="option"
              aria-selected={i === mentionIdx}
              className={i === mentionIdx ? 'mc-mention-item mc-mention-item-active' : 'mc-mention-item'}
              onMouseDown={e => { e.preventDefault(); insertMention(agent.name); }}
            >
              <span>@{agent.name}</span>
              {agent.description && (
                <span className="mc-mention-desc">{agent.description}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
