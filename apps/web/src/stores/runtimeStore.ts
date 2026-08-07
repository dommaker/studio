import { create } from 'zustand';
import type { Execution } from '../types';
import { runtimeWorkflowApi } from '../api';

interface RuntimeWorkflow {
  id: string;
  name: string;
  description?: string;
  steps?: string[];
  stepIds?: string[];
  metadata?: Record<string, unknown>;
  openclaw?: {
    userInvocable?: boolean;
    emoji?: string;
    keywords?: string[];
  };
}

interface RuntimeState {
  runtimeWorkflows: RuntimeWorkflow[];
  runtimeExecutions: Execution[];
  loadRuntimeWorkflows: () => Promise<void>;
  executeRuntimeWorkflow: (workflowId: string, inputs: Record<string, unknown>) => Promise<Execution>;
  loadExecutions: (options?: { page?: number; limit?: number }) => Promise<void>;
  updateExecution: (id: string, update: Partial<Execution>) => void;
  removeExecution: (id: string) => void;
}

export const useRuntimeStore = create<RuntimeState>((set, get) => ({
  runtimeWorkflows: [],
  runtimeExecutions: [],
  loadRuntimeWorkflows: async () => {
    // Workflows 功能已在 Agent Network 架构中废弃，返回空数组
    set({ runtimeWorkflows: [] });
  },
  executeRuntimeWorkflow: async (workflowId, inputs) => {
    const { runtimeWorkflows } = get();
    const workflow = runtimeWorkflows.find(w => w.id === workflowId);

    const execution: Execution = {
      id: `runtime-${Date.now()}`,
      workflowName: workflow?.name || workflowId,
      status: 'running',
      input: JSON.stringify(inputs),
      startedAt: new Date().toISOString(),
    };

    set(state => ({ runtimeExecutions: [execution, ...state.runtimeExecutions] }));

    try {
      const { data } = await runtimeWorkflowApi.execute(workflowId, inputs);
      if (data.executionId) {
        set(state => ({
          runtimeExecutions: state.runtimeExecutions.map(e =>
            e.id === execution.id ? { ...e, id: data.executionId } : e
          )
        }));
      }
      return { ...execution, ...data };
    } catch (error) {
      set(state => ({
        runtimeExecutions: state.runtimeExecutions.map(e =>
          e.id === execution.id ? { ...e, status: 'failed', error: (error as Error).message } : e
        )
      }));
      throw error;
    }
  },
  loadExecutions: async (options) => {
    try {
      const response = await runtimeWorkflowApi.listExecutions(options);
      const result = response.data;
      const data = Array.isArray(result) ? result : (result.data || []);
      set({ runtimeExecutions: data });
    } catch (error) {
      console.error('Failed to load runtime executions:', error);
    }
  },
  updateExecution: (id, update) => {
    set(state => ({
      runtimeExecutions: state.runtimeExecutions.map(e =>
        e.id !== id ? e : { ...e, ...update }
      )
    }));
  },
  removeExecution: (id) => {
    set(state => ({
      runtimeExecutions: state.runtimeExecutions.filter(e => e.id !== id)
    }));
  },
}));
