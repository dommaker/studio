// ExecutionResult - 执行结果展示（深色主题）
import type { Execution } from '../types';
import { toast } from '../utils/toast';
import '../styles/theme.css';

interface ExecutionResultProps {
  execution: Execution | null;
  onClose: () => void;
}

export function ExecutionResult({ execution, onClose }: ExecutionResultProps) {
  if (!execution) return null;

  const isSuccess = execution.status === 'succeeded';
  const isRunning = execution.status === 'running';

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50" style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}>
      <div className="rounded-2xl shadow-2xl w-[600px] max-h-[80vh] flex flex-col overflow-hidden" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }}>
        {/* Header */}
        <div className="h-14 flex items-center justify-between px-6" style={{
          background: isSuccess 
            ? 'linear-gradient(to right, #10b981, #059669)' 
            : isRunning 
              ? 'linear-gradient(to right, #3b82f6, #06b6d4)'
              : 'linear-gradient(to right, #ef4444, #ec4899)'
        }}>
          <h2 className="font-bold text-white flex items-center gap-2">
            <span className="text-2xl">
              {isSuccess ? '✅' : isRunning ? '⏳' : '❌'}
            </span>
            <span>
              {isSuccess ? '执行成功' : isRunning ? '执行中...' : '执行失败'}
            </span>
          </h2>
          <button onClick={onClose} className="text-2xl" style={{ color: 'rgba(255,255,255,0.7)' }}>
            ✕
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-6">
          {/* 执行信息 */}
          <div className="mb-6 p-4 rounded-xl" style={{ background: 'var(--bg-tertiary)' }}>
            <div className="text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>执行 ID</div>
            <div className="font-mono text-xs p-2 rounded" style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}>{execution.id}</div>
          </div>

          {/* 节点执行结果 */}
          {execution.nodeExecutions && execution.nodeExecutions.length > 0 && (
            <div className="space-y-4">
              <div className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>节点执行结果</div>
              {execution.nodeExecutions.map((node: any, i: number) => (
                <div key={node.nodeId || i} className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border-subtle)' }}>
                  <div className="px-4 py-3 flex items-center gap-2" style={{
                    background: node.status === 'succeeded' 
                      ? 'rgba(16, 185, 129, 0.1)' 
                      : node.status === 'running'
                        ? 'rgba(59, 130, 246, 0.1)'
                        : 'rgba(239, 68, 68, 0.1)',
                    borderBottom: '1px solid var(--border-subtle)'
                  }}>
                    <span className="text-lg">
                      {node.status === 'succeeded' ? '✅' : node.status === 'running' ? '⏳' : '❌'}
                    </span>
                    <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{node.nodeId}</span>
                  </div>
                  {node.output && (
                    <div className="p-4" style={{ background: 'var(--bg-secondary)' }}>
                      <div className="text-xs mb-2" style={{ color: 'var(--text-tertiary)' }}>输出</div>
                      <pre className="text-sm p-4 rounded-lg overflow-auto max-h-96 font-mono whitespace-pre-wrap break-words leading-relaxed" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}>
                        {typeof node.output === 'string' 
                          ? node.output 
                          : JSON.stringify(node.output, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* 错误信息 */}
          {(execution as any).error && (
            <div className="mt-4 p-4 rounded-xl" style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)' }}>
              <div className="text-sm font-medium mb-1" style={{ color: 'var(--error)' }}>错误信息</div>
              <div className="text-sm" style={{ color: 'var(--error)' }}>{String((execution as any).error)}</div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 flex justify-end gap-2" style={{ background: 'var(--bg-tertiary)', borderTop: '1px solid var(--border-subtle)' }}>
          <button
            onClick={onClose}
            className="btn btn-secondary"
          >
            关闭
          </button>
          {isSuccess && (
            <button
              onClick={() => {
                navigator.clipboard.writeText(JSON.stringify(execution.nodeExecutions, null, 2));
                toast.success('已复制到剪贴板');
              }}
              className="btn btn-primary"
            >
              复制结果
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
