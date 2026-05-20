// ExecutionHistory - 执行历史面板（深色主题）
// @ts-nocheck - This component is deprecated after routing refactor, not used anymore
import { useState, useEffect } from 'react';
import { useRuntimeStore, useWorkflowStore } from '../stores';
import type { Execution } from '../types';
import '../styles/theme.css';

interface ExecutionHistoryProps {
  onClose: () => void;
}

export function ExecutionHistory({ onClose }: ExecutionHistoryProps) {
  const { runtimeExecutions: executions, loadExecutions } = useRuntimeStore();
  const { selectedWorkflow } = useWorkflowStore();
  const [selectedExecution, setSelectedExecution] = useState<Execution | null>(null);

  useEffect(() => {
    loadExecutions(selectedWorkflow?.id);
  }, [loadExecutions, selectedWorkflow?.id]);

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'pending': return 'var(--text-tertiary)';
      case 'running': return 'var(--info)';
      case 'succeeded': return 'var(--success)';
      case 'failed': return 'var(--error)';
      case 'cancelled': return 'var(--warning)';
      default: return 'var(--text-secondary)';
    }
  };

  const getStatusBg = (status: string) => {
    switch (status) {
      case 'pending': return 'rgba(139, 148, 158, 0.1)';
      case 'running': return 'rgba(59, 130, 246, 0.1)';
      case 'succeeded': return 'rgba(16, 185, 129, 0.1)';
      case 'failed': return 'rgba(239, 68, 68, 0.1)';
      case 'cancelled': return 'rgba(245, 158, 11, 0.1)';
      default: return 'var(--bg-tertiary)';
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" style={{ backdropFilter: 'blur(4px)' }}>
      <div className="rounded-lg shadow-xl w-[800px] max-h-[80vh] flex flex-col" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)' }}>
        {/* Header */}
        <div className="h-12 border-b flex items-center justify-between px-4" style={{ borderColor: 'var(--border-subtle)' }}>
          <h2 className="font-bold" style={{ color: 'var(--text-primary)' }}>执行历史</h2>
          <button onClick={onClose} className="hover:opacity-70" style={{ color: 'var(--text-tertiary)' }}>
            ✕
          </button>
        </div>

        <div className="flex-1 flex overflow-hidden">
          {/* 左侧列表 */}
          <div className="w-1/2 border-r overflow-auto" style={{ borderColor: 'var(--border-subtle)' }}>
            {executions.length === 0 ? (
              <div className="text-center py-8" style={{ color: 'var(--text-tertiary)' }}>
                暂无执行记录
              </div>
            ) : (
              <div className="divide-y" style={{ borderColor: 'var(--border-subtle)' }}>
                {executions.map((exec) => (
                  <button
                    key={exec.id}
                    onClick={() => setSelectedExecution(exec)}
                    className="w-full text-left p-4 transition-colors"
                    style={{
                      background: selectedExecution?.id === exec.id ? 'var(--bg-tertiary)' : 'transparent',
                      borderColor: 'var(--border-subtle)'
                    }}
                    onMouseEnter={(e) => {
                      if (selectedExecution?.id !== exec.id) {
                        e.currentTarget.style.background = 'var(--bg-hover)';
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (selectedExecution?.id !== exec.id) {
                        e.currentTarget.style.background = 'transparent';
                      }
                    }}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>
                        {exec.id.slice(0, 8)}...
                      </span>
                      <span className="text-xs px-2 py-0.5 rounded" style={{ background: getStatusBg(exec.status), color: getStatusColor(exec.status) }}>
                        {exec.status}
                      </span>
                    </div>
                    <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                      {exec.startTime && new Date(exec.startTime).toLocaleString()}
                    </div>
                    {exec.endTime && (
                      <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                        耗时: {Math.round((new Date(exec.endTime).getTime() - new Date(exec.startTime || 0).getTime()) / 1000)}s
                      </div>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 右侧详情 */}
          <div className="w-1/2 overflow-auto p-4">
            {!selectedExecution ? (
              <div className="text-center py-8" style={{ color: 'var(--text-tertiary)' }}>
                选择一条执行记录查看详情
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <div className="text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>基本信息</div>
                  <div className="rounded p-3 text-sm" style={{ background: 'var(--bg-tertiary)' }}>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <span style={{ color: 'var(--text-tertiary)' }}>ID:</span> 
                        <span style={{ color: 'var(--text-primary)' }}>{selectedExecution.id}</span>
                      </div>
                      <div>
                        <span style={{ color: 'var(--text-tertiary)' }}>状态:</span>{' '}
                        <span style={{ color: getStatusColor(selectedExecution.status) }}>
                          {selectedExecution.status}
                        </span>
                      </div>
                      <div>
                        <span style={{ color: 'var(--text-tertiary)' }}>开始:</span>{' '}
                        <span style={{ color: 'var(--text-primary)' }}>
                          {selectedExecution.startTime 
                            ? new Date(selectedExecution.startTime).toLocaleString()
                            : '-'}
                        </span>
                      </div>
                      <div>
                        <span style={{ color: 'var(--text-tertiary)' }}>结束:</span>{' '}
                        <span style={{ color: 'var(--text-primary)' }}>
                          {selectedExecution.endTime
                            ? new Date(selectedExecution.endTime).toLocaleString()
                            : '-'}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* 节点执行 */}
                {selectedExecution.nodeExecutions && selectedExecution.nodeExecutions.length > 0 && (
                  <div>
                    <div className="text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>节点执行</div>
                    <div className="space-y-2">
                      {selectedExecution.nodeExecutions.map((node) => (
                        <div key={node.nodeId} className="border rounded p-2 text-sm" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)' }}>
                          <div className="flex items-center justify-between">
                            <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{node.nodeId}</span>
                            <span className="text-xs" style={{ color: getStatusColor(node.status) }}>
                              {node.status}
                            </span>
                          </div>
                          {node.error && (
                            <div className="text-xs mt-1" style={{ color: 'var(--error)' }}>
                              {node.error.message}
                            </div>
                          )}
                          {node.output && (
                            <details className="mt-2">
                              <summary className="text-xs cursor-pointer" style={{ color: 'var(--text-tertiary)' }}>
                                输出
                              </summary>
                              <pre className="text-xs p-2 rounded mt-1 overflow-auto" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}>
                                {JSON.stringify(node.output, null, 2)}
                              </pre>
                            </details>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* 错误信息 */}
                {selectedExecution.nodeExecutions?.[0]?.error && (
                  <div>
                    <div className="text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>错误</div>
                    <div className="rounded p-3 text-sm" style={{ background: 'rgba(239, 68, 68, 0.1)', color: 'var(--error)' }}>
                      {selectedExecution.nodeExecutions?.[0]?.error.message}
                    </div>
                  </div>
                )}

                {/* 参数 */}
                {selectedExecution.parameters && Object.keys(selectedExecution.parameters).length > 0 && (
                  <div>
                    <div className="text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>参数</div>
                    <pre className="rounded p-3 text-xs overflow-auto" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}>
                      {JSON.stringify(selectedExecution.parameters, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
