/**
 * WebSocket 事件处理 hook
 * - handleWebSocketMessage（12 种事件类型）
 * - thinkingMessages / isThinking state
 */
import { useState, useCallback, useRef } from 'react';
import type { ExecutionState, ThinkingMessage } from '../types';
import type { WebSocketMessage } from '../api/websocket';

const MAX_THINKING_MESSAGES = 100;

export function useWebSocketHandlers(setExecutions: React.Dispatch<React.SetStateAction<ExecutionState[]>>) {
  const [thinkingMessages, setThinkingMessages] = useState<ThinkingMessage[]>([]);
  const [isThinking, setIsThinking] = useState(false);
  const [currentExecution, setCurrentExecution] = useState<ExecutionState | null>(null);
  const thinkingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleWebSocketMessage = useCallback((message: WebSocketMessage) => {
    const { event_type, data } = message;

    switch (event_type) {
      case 'runtime.event':
      case 'step.started':
      case 'step.completed':
      case 'step.failed':
      case 'runtime.step.started':
      case 'runtime.step.completed':
      case 'runtime.step.failed':
      case 'runtime.workflow.started':
      case 'runtime.workflow.completed':
      case 'runtime.workflow.failed':
        if (data.executionId) {
          setThinkingMessages(prev => {
            const newMsg: ThinkingMessage = {
              id: `runtime-${Date.now()}`,
              executionId: data.executionId,
              type: data.type?.includes('completed') ? 'step_complete' :
                data.type?.includes('failed') ? 'step_complete' : 'step_start',
              stepId: data.stepId,
              stepName: data.stepName || data.stepId,
              content: data.output || data.error,
              timestamp: new Date(),
            };
            return [...prev.slice(-MAX_THINKING_MESSAGES + 1), newMsg];
          });
        }
        break;

      case 'thinking.stream':
        setIsThinking(true);
        setThinkingMessages(prev => {
          const newMsg = {
            id: message.event_id,
            executionId: data.executionId,
            type: data.type,
            stepId: data.stepId,
            stepName: data.stepName,
            content: data.content,
            progress: data.progress,
            timestamp: new Date(),
          };
          const updated = [...prev, newMsg];
          return updated.slice(-MAX_THINKING_MESSAGES);
        });
        if (data.type === 'step_complete') {
          if (thinkingTimeoutRef.current) clearTimeout(thinkingTimeoutRef.current);
          thinkingTimeoutRef.current = setTimeout(() => setIsThinking(false), 500);
        }
        break;

      case 'pipeline.step_started':
        setThinkingMessages(prev => {
          const newMsg: ThinkingMessage = {
            id: `step-start-${message.event_id}`,
            executionId: data.executionId,
            type: 'step_start',
            stepId: data.stepId || `step-${data.stepIndex}`,
            stepName: data.stepName || `步骤 ${data.stepIndex + 1}`,
            timestamp: new Date(),
          };
          return [...prev.slice(-MAX_THINKING_MESSAGES + 1), newMsg];
        });
        setIsThinking(true);
        setExecutions(prev => prev.map(exec => {
          if (exec.id !== data.executionId) return exec;
          return {
            ...exec,
            currentStep: data.stepIndex + 1,
            steps: exec.steps.map((s, i) =>
              i === data.stepIndex ? { ...s, status: 'running' as const, startedAt: new Date().toISOString() } : s
            ),
          };
        }));
        break;

      case 'pipeline.step_completed':
        setThinkingMessages(prev => {
          const newMsg: ThinkingMessage = {
            id: `step-complete-${message.event_id}`,
            executionId: data.executionId,
            type: 'step_complete',
            stepId: data.stepId || `step-${data.stepIndex}`,
            stepName: data.stepName || `步骤 ${data.stepIndex + 1}`,
            content: data.output,
            timestamp: new Date(),
          };
          return [...prev.slice(-MAX_THINKING_MESSAGES), newMsg];
        });
        setExecutions(prev => prev.map(exec => {
          if (exec.id !== data.executionId) return exec;
          return {
            ...exec,
            steps: exec.steps.map((s, i) =>
              i === data.stepIndex ? { ...s, status: data.status, output: data.output, completedAt: new Date().toISOString() } : s
            ),
          };
        }));
        break;

      case 'pipeline.completed':
        setExecutions(prev => prev.map(exec =>
          exec.id === data.executionId ? { ...exec, status: 'succeeded', completedAt: new Date().toISOString() } : exec
        ));
        break;

      case 'pipeline.failed':
        setExecutions(prev => prev.map(exec =>
          exec.id === data.executionId ? { ...exec, status: 'failed', error: data.error } : exec
        ));
        break;

      case 'execution.started':
        setCurrentExecution({ ...data, status: 'running' } as ExecutionState);
        break;

      case 'execution.completed':
        setCurrentExecution(prev => prev ? { ...prev, status: 'succeeded' } : null);
        break;

      case 'execution.failed':
        setCurrentExecution(prev => prev ? { ...prev, status: 'failed' } : null);
        break;

      // NA Step 8: Agent 进度事件
      case 'agent.progress': {
        const phase = data?.phase || 'running';
        const session = data?.session || 1;
        setCurrentExecution(prev => prev ? {
          ...prev,
          status: 'running',
          phase,
          session,
        } : null);
        break;
      }

      case 'agent.heartbeat': {
        const currentStep = data?.currentStep || '';
        const runningDuration = data?.runningDuration || '';
        setCurrentExecution(prev => prev ? {
          ...prev,
          status: 'running',
          currentStep,
          runningDuration,
        } : null);
        break;
      }

      case 'agent.completed':
        setCurrentExecution(prev => prev ? { ...prev, status: 'succeeded' } : null);
        break;

      case 'agent.failed':
        setCurrentExecution(prev => prev ? {
          ...prev,
          status: 'failed',
          error: data?.error || 'Agent execution failed',
        } : null);
        break;
    }
  }, [setExecutions]);

  return {
    thinkingMessages,
    isThinking,
    currentExecution,
    setCurrentExecution,
    handleWebSocketMessage,
  };
}
