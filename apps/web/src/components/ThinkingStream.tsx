// ThinkingStream - 实时思考流组件
import { useEffect, useRef, useState } from 'react';
import type { ThinkingMessage } from '../types';

interface ThinkingStreamProps {
  messages: ThinkingMessage[];
  isThinking: boolean;
  currentExecutionId?: string;
}

export function ThinkingStream({ messages, isThinking, currentExecutionId }: ThinkingStreamProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [displayedContent, setDisplayedContent] = useState<Record<string, string>>({});

  // 过滤当前执行的消息
  const filteredMessages = currentExecutionId
    ? messages.filter(m => m.executionId === currentExecutionId)
    : messages;

  // 自动滚动到底部
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [filteredMessages]);

  // 打字机效果
  useEffect(() => {
    filteredMessages.forEach(msg => {
      const content = msg.content || '';
      const displayed = displayedContent[msg.id]?.length || 0;
      
      if (content.length > displayed) {
        const timer = setTimeout(() => {
          setDisplayedContent(prev => ({
            ...prev,
            [msg.id]: content.slice(0, (prev[msg.id]?.length || 0) + 10),
          }));
        }, 30);
        return () => clearTimeout(timer);
      }
    });
  }, [filteredMessages, displayedContent]);

  // 角色图标
  const roleIcons: Record<string, string> = {
    'requirements': '👔',
    'rdqa': '📋',
    'architecture': '🏗️',
    'frontend': '🎨',
    'backend': '⚙️',
    'test': '🧪',
    'deploy': '🚀',
    '产品总监': '👔',
    '产品经理': '📋',
    '技术总监': '🏗️',
    '前端工程师': '🎨',
    '后端工程师': '⚙️',
    'QA测试': '🧪',
    '运维': '🚀',
  };

  // 类型图标
  const typeIcons: Record<string, string> = {
    'step_start': '▶️',
    'step_progress': '⏳',
    'step_output': '📤',
    'step_complete': '✅',
    'thinking': '🧠',
    'action': '⚡',
  };

  if (filteredMessages.length === 0 && !isThinking) {
    return null;
  }

  return (
    <div className="u-surface rounded-xl border u-border overflow-hidden shadow-sm">
      {/* 头部 */}
      <div className="px-4 py-3 bg-gradient-to-r from-indigo-50 to-purple-50 border-b u-border">
        <div className="flex items-center gap-2">
          <span className="text-lg">🧠</span>
          <span className="font-semibold u-text">思考流</span>
          {isThinking && (
            <span className="ml-2 px-2 py-0.5 u-accent-dim u-accent text-xs rounded-full animate-pulse">
              思考中...
            </span>
          )}
        </div>
      </div>

      {/* 思考内容 */}
      <div
        ref={containerRef}
        className="max-h-80 overflow-y-auto p-4 space-y-3"
      >
        {filteredMessages.map(msg => (
          <div key={msg.id} className="flex gap-3 animate-fade-in">
            {/* 角色图标 */}
            <div className="flex-shrink-0 w-8 h-8 rounded-full u-accent-dim flex items-center justify-center text-lg">
              {roleIcons[msg.stepId || ''] || typeIcons[msg.type] || '🤖'}
            </div>

            {/* 内容 */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="font-medium u-text text-sm">
                  {msg.stepName || msg.stepId || 'Agent'}
                </span>
                <span className="text-xs u-text-3">
                  {msg.timestamp instanceof Date 
                    ? msg.timestamp.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
                    : new Date(msg.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                </span>
                {msg.progress !== undefined && (
                  <span className="text-xs u-accent">
                    {Math.round(msg.progress * 100)}%
                  </span>
                )}
              </div>
              
              {/* 消息内容 */}
              {(displayedContent[msg.id] || msg.content) && (
                <div className="text-sm u-text whitespace-pre-wrap u-surface-2 rounded-lg p-2 mt-1">
                  {displayedContent[msg.id] || msg.content}
                </div>
              )}
            </div>
          </div>
        ))}

        {/* 思考中指示器 */}
        {isThinking && filteredMessages.length === 0 && (
          <div className="flex items-center gap-2 u-text-2 text-sm py-2">
            <div className="flex gap-1">
              <span className="w-2 h-2 u-accent rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-2 h-2 u-accent rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-2 h-2 u-accent rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
            <span>等待 Agent 响应...</span>
          </div>
        )}
      </div>
    </div>
  );
}

// 简化版思考流指示器
export function ThinkingIndicator({ stepName }: { stepName?: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 u-accent-dim rounded-lg">
      <div className="flex gap-1">
        <span className="w-2 h-2 u-accent rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
        <span className="w-2 h-2 u-accent rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
        <span className="w-2 h-2 u-accent rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
      </div>
      <span className="text-sm u-accent">
        {stepName ? `${stepName} 执行中...` : '思考中...'}
      </span>
    </div>
  );
}
