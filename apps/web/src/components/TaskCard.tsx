// TaskCard.tsx - 执行任务卡片组件
import { useState } from 'react';
import type { ExecutionState, ThinkingMessage } from '../types';

interface TaskCardProps {
  execution: ExecutionState;
  thinkingMessages: ThinkingMessage[];
  isThinking: boolean;
  onCancel?: (id: string) => void;
  onViewDetails?: (execution: ExecutionState) => void;
  onRetry?: (id: string) => void;
  onDelete?: (id: string) => void;
}

export function TaskCard({ execution, thinkingMessages, isThinking, onCancel, onViewDetails, onRetry, onDelete }: TaskCardProps) {
  const [expanded, setExpanded] = useState(isThinking);

  const statusText: Record<string, string> = {
    running: '运行中',
    succeeded: '已完成',
    completed: '已完成',
    failed: '失败',
    pending: '等待中',
    cancelled: '已取消',
    paused: '已暂停',
  };

  return (
    <div
      className="rounded-lg border p-4"
      style={{
        background: 'var(--bg-secondary)',
        borderColor: expanded ? 'var(--accent-primary)' : 'var(--border-subtle)',
      }}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-mono" style={{ color: 'var(--text-muted)' }}>
          #{execution.id.slice(0, 8)}
        </span>
        <span
          className="text-xs px-2 py-0.5 rounded-full"
          style={{
            background:
              execution.status === 'running' ? 'rgba(59, 130, 246, 0.1)' :
              execution.status === 'succeeded' ? 'rgba(16, 185, 129, 0.1)' :
              execution.status === 'failed' ? 'rgba(239, 68, 68, 0.1)' :
              'var(--bg-tertiary)',
            color:
              execution.status === 'running' ? 'var(--info)' :
              execution.status === 'succeeded' ? 'var(--success)' :
              execution.status === 'failed' ? 'var(--error)' :
              'var(--text-tertiary)',
          }}
        >
          {statusText[execution.status] || execution.status}
        </span>
      </div>

      <div
        className="text-sm mb-2 cursor-pointer"
        style={{ color: 'var(--text-primary)' }}
        onClick={() => setExpanded(!expanded)}
      >
        {execution.input.length > 50 ? execution.input.slice(0, 50) + '...' : execution.input}
      </div>

      <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
        进度: {execution.currentStep}/{execution.totalSteps}
      </div>

      {expanded && (
        <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <div className="text-xs font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
            执行时间线
          </div>
          {thinkingMessages.length > 0 && (
            <div className="space-y-1 mb-3">
              {thinkingMessages.map((msg) => (
                <div key={msg.id} className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {msg.stepName && <span className="font-medium">{msg.stepName}: </span>}
                  {msg.content ? (
                    msg.content.length > 100 ? msg.content.slice(0, 100) + '...' : msg.content
                  ) : msg.type === 'step_start' ? '开始执行' : msg.type === 'step_complete' ? '执行完成' : ''}
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-2 mt-2">
            {onCancel && execution.status === 'running' && (
              <button onClick={() => onCancel(execution.id)} className="btn btn-ghost text-xs">
                取消
              </button>
            )}
            {onViewDetails && (
              <button onClick={() => onViewDetails(execution)} className="btn btn-ghost text-xs">
                查看详情
              </button>
            )}
            {onRetry && execution.status === 'failed' && (
              <button onClick={() => onRetry(execution.id)} className="btn btn-ghost text-xs">
                重试
              </button>
            )}
            {onDelete && (
              <button onClick={() => onDelete(execution.id)} className="btn btn-ghost text-xs">
                删除
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default TaskCard;
