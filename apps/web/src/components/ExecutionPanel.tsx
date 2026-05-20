// ExecutionPanel - 执行状态面板（深色主题）
// @ts-nocheck - This component is deprecated after routing refactor, not used anymore
import { useEffect, useState, useCallback } from 'react';
import { useWorkflowStore } from '../stores';
import { useWebSocket } from '../api/websocket';
import { taskApi } from '../api';
import { CheckpointTimeline, type CheckpointResult } from './CheckpointTimeline';
import type { WebSocketMessage } from '../api/websocket';
import type { Execution, NodeExecution } from '../types';
import '../styles/theme.css';

// 任务状态类型
interface Task {
  id: string;
  workflowId: string;
  executionId: string;
  nodeId: string;
  agentType: string;
  prompt: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  progress?: number;
  message?: string;
  output?: any;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

// 队列统计
interface QueueStats {
  pending: number;
  running: number;
  completed: number;
}

export function ExecutionPanel() {
  const { selectedWorkflow } = useWorkflowStore();
  const currentExecution = undefined;
  const [execution, setExecution] = useState<Execution | null>(null);
  const [nodeExecutions, setNodeExecutions] = useState<NodeExecution[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [queueStats, setQueueStats] = useState<QueueStats | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [checkpoints, setCheckpoints] = useState<CheckpointResult[]>([]);

  // 处理 WebSocket 消息
  const handleWebSocketMessage = useCallback((message: WebSocketMessage) => {
    const { event_type, data } = message;

    switch (event_type) {
      case 'execution.started':
        setExecution({ ...data, status: 'running' });
        addLog(`🚀 工作流开始执行: ${data.workflowName}`);
        break;

      case 'execution.completed':
        setExecution((prev) => prev ? { ...prev, status: 'succeeded' } : null);
        addLog(`✅ 工作流执行完成`);
        break;

      case 'execution.failed':
        setExecution((prev) => prev ? { ...prev, status: 'failed' } : null);
        addLog(`❌ 工作流执行失败: ${data.error}`);
        break;

      case 'node.status_changed':
        setNodeExecutions((prev) => {
          const existing = prev.find((n) => n.nodeId === data.nodeId);
          if (existing) {
            return prev.map((n) =>
              n.nodeId === data.nodeId
                ? { ...n, status: data.status, output: data.output, error: data.error }
                : n
            );
          }
          return [...prev, { 
            nodeId: data.nodeId, 
            status: data.status,
            startTime: data.startTime,
            endTime: data.endTime,
            output: data.output,
            error: data.error,
          }];
        });

        const statusEmoji = {
          running: '⏳',
          succeeded: '✅',
          failed: '❌',
          pending: '⏸️',
        }[String(data.status)] || '❓';

        addLog(`${statusEmoji} 节点 [${data.nodeName || data.nodeId}]: ${data.status}`);
        break;

      // 任务状态变更
      case 'task.status_changed':
        setTasks((prev) => {
          const existing = prev.find((t) => t.id === data.task_id);
          if (existing) {
            return prev.map((t) =>
              t.id === data.task_id
                ? { 
                    ...t, 
                    status: data.status, 
                    progress: data.progress,
                    message: data.message,
                    output: data.output,
                    error: data.error,
                  }
                : t
            );
          }
          return [...prev, {
            id: data.task_id,
            executionId: data.execution_id,
            nodeId: data.node_id,
            status: data.status,
            progress: data.progress,
            message: data.message,
            output: data.output,
            error: data.error,
          } as Task];
        });

        const taskEmoji = {
          pending: '⏸️',
          running: '⏳',
          succeeded: '✅',
          failed: '❌',
        }[String(data.status)] || '❓';

        const progressText = data.progress !== undefined ? ` (${data.progress}%)` : '';
        addLog(`${taskEmoji} 任务 [${data.task_id?.slice(0, 8)}]: ${data.status}${progressText}`);
        break;

      case 'connection.established':
        addLog('✅ WebSocket 连接成功');
        break;

      // 检查点验证
      case 'checkpoint.validated':
        setCheckpoints((prev) => {
          const existing = prev.find((c) => c.checkpointId === data.checkpointId);
          if (existing) {
            return prev.map((c) =>
              c.checkpointId === data.checkpointId ? data : c
            );
          }
          return [...prev, data];
        });
        addLog(`🔍 检查点 [${data.checkpointId}]: ${data.passed ? '通过' : '失败'}`);
        break;
    }
  }, []);

  // 连接 WebSocket
  const { status: wsStatus, subscribe } = useWebSocket({
    onMessage: handleWebSocketMessage,
    reconnect: true,
  });

  // 当有执行任务时，订阅执行事件
  useEffect(() => {
    if (currentExecution && wsStatus === 'connected') {
      subscribe(currentExecution.id);
    }
  }, [currentExecution, wsStatus, subscribe]);

  // 轮询队列统计
  useEffect(() => {
    const fetchStats = async () => {
      try {
        const response = await taskApi.getQueueStats();
        setQueueStats(response.data);
      } catch (error) {
        // 忽略错误
      }
    };

    fetchStats();
    const interval = setInterval(fetchStats, 5000); // 每 5 秒更新
    return () => clearInterval(interval);
  }, []);

  // 添加日志
  const addLog = (message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev.slice(-100), `[${timestamp}] ${message}`]);
  };

  if (!currentExecution) {
    return (
      <div className="w-80 border-l flex items-center justify-center" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)', color: 'var(--text-tertiary)' }}>
        <div className="text-center">
          <div className="text-4xl mb-2">📋</div>
          <div>选择工作流并点击运行</div>
        </div>
      </div>
    );
  }

  return (
    <div className="w-80 border-l flex flex-col" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)' }}>
      {/* Header */}
      <div className="h-12 border-b flex items-center px-3" style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}>
        <span className="font-medium" style={{ color: 'var(--text-primary)' }}>执行状态</span>
        <div className="ml-auto flex items-center gap-1">
          <span className={`w-2 h-2 rounded-full ${
            wsStatus === 'connected' ? 'status-online' : 
            wsStatus === 'connecting' ? 'status-pending' : 'status-offline'
          }`} />
          <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
            {wsStatus === 'connected' ? '已连接' : 
             wsStatus === 'connecting' ? '连接中...' : '未连接'}
          </span>
        </div>
      </div>

      {/* 执行概览 */}
      <div className="p-3 border-b" style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}>
        <div className="flex items-center gap-2 mb-2">
          <StatusBadge status={execution?.status || currentExecution.status} />
          <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            {selectedWorkflow?.name || '工作流'}
          </span>
        </div>
        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
          ID: {currentExecution.id.slice(0, 8)}...
        </div>
      </div>

      {/* 队列状态 */}
      {queueStats && (
        <div className="p-3 border-b" style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}>
          <div className="text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>任务队列</div>
          <div className="flex gap-3 text-xs">
            <div className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full" style={{ background: 'var(--warning)' }} />
              <span style={{ color: 'var(--text-secondary)' }}>待处理: {queueStats.pending}</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full" style={{ background: 'var(--info)' }} />
              <span style={{ color: 'var(--text-secondary)' }}>运行中: {queueStats.running}</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full status-online" />
              <span style={{ color: 'var(--text-secondary)' }}>已完成: {queueStats.completed}</span>
            </div>
          </div>
        </div>
      )}

      {/* 任务列表 */}
      {tasks.length > 0 && (
        <div className="p-3 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>任务详情</div>
          <div className="space-y-2 max-h-32 overflow-auto">
            {tasks.map((task) => (
              <div
                key={task.id}
                className="flex items-center gap-2 p-2 rounded border"
                style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border-subtle)' }}
              >
                <StatusIcon status={task.status} />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                    {task.agentType || task.nodeId}
                  </div>
                  {task.message && (
                    <div className="text-xs truncate" style={{ color: 'var(--text-tertiary)' }}>
                      {task.message}
                    </div>
                  )}
                </div>
                {task.progress !== undefined && task.progress > 0 && (
                  <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    {task.progress}%
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 检查点验证时间线 */}
      {checkpoints.length > 0 && (
        <div className="p-3 border-b" style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}>
          <CheckpointTimeline checkpoints={checkpoints} />
        </div>
      )}

      {/* 节点执行状态 */}
      <div className="flex-1 overflow-auto p-3">
        <div className="text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>节点执行</div>
        {nodeExecutions.length === 0 ? (
          <div className="text-sm" style={{ color: 'var(--text-tertiary)' }}>等待执行...</div>
        ) : (
          <div className="space-y-2">
            {nodeExecutions.map((node) => (
              <div
                key={node.nodeId}
                className="flex items-center gap-2 p-2 rounded border"
                style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border-subtle)' }}
              >
                <StatusIcon status={node.status} />
                <span className="text-sm flex-1" style={{ color: 'var(--text-primary)' }}>{node.nodeId}</span>
                <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{node.status}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 日志面板 */}
      <div className="h-40 border-t" style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-subtle)' }}>
        <div className="h-8 flex items-center px-3 text-sm" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>
          日志
        </div>
        <div className="h-32 overflow-auto p-2 font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>
          {logs.map((log, i) => (
            <div key={i} className="whitespace-pre-wrap">
              {log}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// 状态徽章
function StatusBadge({ status }: { status: string }) {
  const getStyle = (s: string) => {
    switch (s) {
      case 'pending': return { bg: 'rgba(139, 148, 158, 0.1)', color: 'var(--text-tertiary)' };
      case 'running': return { bg: 'rgba(59, 130, 246, 0.1)', color: 'var(--info)' };
      case 'succeeded': return { bg: 'rgba(16, 185, 129, 0.1)', color: 'var(--success)' };
      case 'failed': return { bg: 'rgba(239, 68, 68, 0.1)', color: 'var(--error)' };
      case 'cancelled': return { bg: 'rgba(245, 158, 11, 0.1)', color: 'var(--warning)' };
      default: return { bg: 'var(--bg-tertiary)', color: 'var(--text-secondary)' };
    }
  };

  const labels: Record<string, string> = {
    pending: '待执行',
    running: '执行中',
    succeeded: '成功',
    failed: '失败',
    cancelled: '已取消',
  };

  const style = getStyle(status);

  return (
    <span className="px-2 py-0.5 rounded text-xs font-medium transition-all" style={{ background: style.bg, color: style.color }}>
      {labels[status] || status}
    </span>
  );
}

// 状态图标
function StatusIcon({ status }: { status: string }) {
  const icons: Record<string, string> = {
    pending: '⏸️',
    running: '⏳',
    succeeded: '✅',
    failed: '❌',
    cancelled: '🚫',
  };

  return <span>{icons[status] || '❓'}</span>;
}
