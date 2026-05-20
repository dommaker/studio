// Channel message input — B2: @mention autocomplete
import { useState, useRef, useCallback, useMemo } from 'react';

interface Props {
  onSend: (content: string) => void;
  sending: boolean;
}

const AGENTS = [
  { name: 'Analyst', desc: '需求分析' },
  { name: 'Executor', desc: '代码执行' },
  { name: 'Reviewer', desc: '代码审查' },
  { name: 'KK', desc: '知识管理' },
  { name: 'Auditor', desc: '系统审计' },
  { name: 'Triage', desc: '应急响应' },
  { name: 'Deploy', desc: '部署检查' },
];

export function ChannelInput({ onSend, sending }: Props) {
  const [content, setContent] = useState('');
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionIdx, setMentionIdx] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const charCount = content.length;
  const hasAnalyst = /@analyst/i.test(content);
  const canTrigger = charCount >= 30 && hasAnalyst;

  // Parse if we're in a mention: last @word before cursor
  const mentionState = useMemo(() => {
    const pos = textareaRef.current?.selectionStart ?? content.length;
    const before = content.slice(0, pos);
    const lastAt = before.lastIndexOf('@');
    if (lastAt === -1) return null;
    const query = before.slice(lastAt + 1);
    // Only show if there's no space after @ and before cursor
    if (query.includes(' ') || query.includes('\n')) return null;
    return { start: lastAt, query };
  }, [content]);

  const filteredAgents = useMemo(() => {
    if (!mentionState) return [];
    const q = mentionState.query.toLowerCase();
    return AGENTS.filter(a => a.name.toLowerCase().includes(q));
  }, [mentionState]);

  const insertMention = useCallback((agentName: string) => {
    if (!mentionState) return;
    const pos = textareaRef.current?.selectionStart ?? content.length;
    const before = content.slice(0, mentionState.start);
    const after = content.slice(pos);
    const newContent = `${before}@${agentName} ${after}`;
    setContent(newContent);
    setMentionQuery('');
    setMentionIdx(0);
    // Set cursor after the inserted mention
    setTimeout(() => {
      const el = textareaRef.current;
      if (el) {
        const cursorPos = mentionState.start + agentName.length + 2; // @name[space]
        el.setSelectionRange(cursorPos, cursorPos);
        el.focus();
      }
    }, 0);
  }, [content, mentionState]);

  const handleSend = () => {
    const trimmed = content.trim();
    if (!trimmed || sending) return;
    onSend(trimmed);
    setContent('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Mention popup keyboard navigation
    if (filteredAgents.length > 0) {
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
        setMentionQuery('');
        setMentionIdx(0);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && filteredAgents.length === 0) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="border-t border-gray-200 p-4 bg-white relative">
      <div className="flex items-end gap-3">
        <textarea
          ref={textareaRef}
          value={content}
          onChange={e => setContent(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入消息，@Agent 提及 Agent，@Analyst 触发需求分析..."
          rows={2}
          className="flex-1 resize-none border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          disabled={sending}
        />
        <button
          onClick={handleSend}
          disabled={sending || !content.trim()}
          className="px-4 py-2 bg-blue-500 text-white text-sm rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {sending ? '...' : '发送'}
        </button>
      </div>

      {/* @mention popup */}
      {filteredAgents.length > 0 && (
        <div className="absolute bottom-full left-4 mb-1 w-56 bg-white border border-gray-200 rounded-lg shadow-lg z-50 max-h-48 overflow-y-auto">
          {filteredAgents.map((agent, i) => (
            <button
              key={agent.name}
              className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 transition-colors ${
                i === mentionIdx ? 'bg-blue-50 text-blue-700' : 'hover:bg-gray-50 text-gray-700'
              }`}
              onMouseDown={e => { e.preventDefault(); insertMention(agent.name); }}
            >
              <span className="font-medium">@{agent.name}</span>
              <span className="text-xs text-gray-400 ml-auto">{agent.desc}</span>
            </button>
          ))}
        </div>
      )}

      <div className="flex justify-between items-center mt-1.5 px-1">
        <span className={`text-xs ${canTrigger ? 'text-blue-500 font-medium' : 'text-gray-400'}`}>
          {charCount < 30 && hasAnalyst
            ? `还需 ${30 - charCount} 字触发 @Analyst`
            : canTrigger
              ? '✓ 将触发 @Analyst 需求分析'
              : hasAnalyst
                ? `@Analyst 已识别（${charCount}/30）`
                : filteredAgents.length > 0
                  ? `↑↓ 选择 Enter 确认 Esc 取消`
                  : ''}
        </span>
        <span className="text-xs text-gray-400">{charCount} 字</span>
      </div>
    </div>
  );
}
