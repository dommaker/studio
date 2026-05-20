import { create } from 'zustand';
import { goalApi } from '../api';

interface GoalExecution {
  id: string;
  goalId: string;
  planId: string;
  agentType: string;
  status: string;
  error?: any;
  output?: any;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
}

interface Goal {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  companyId: string;
  context?: any;
  completedAt?: string;
  createdAt: string;
}

interface GoalState {
  goals: Goal[];
  goalExecutions: Record<string, GoalExecution[]>;
  stats: { totalGoals: number; activeGoals: number; completedGoals: number; runningGoalExecutions: number } | null;
  loadGoals: (companyId?: string) => Promise<void>;
  loadStats: (companyId?: string) => Promise<void>;
  loadExecutions: (goalId: string) => Promise<void>;
  cancelExecution: (goalId: string, executionId: string) => Promise<void>;
  retryExecution: (goalId: string, executionId: string) => Promise<void>;
}

export const useGoalStore = create<GoalState>((set, get) => ({
  goals: [],
  goalExecutions: {},
  stats: null,

  loadGoals: async (companyId) => {
    try {
      const { data } = await goalApi.list(companyId ? { companyId } : {});
      const goals = data?.data || data || [];
      set({ goals: Array.isArray(goals) ? goals : [] });
    } catch (e) {
      console.error('Failed to load goals:', e);
    }
  },

  loadStats: async (companyId) => {
    try {
      const { data } = await goalApi.stats(companyId);
      set({ stats: data?.data || data || null });
    } catch (e) {
      console.error('Failed to load goal stats:', e);
    }
  },

  loadExecutions: async (goalId) => {
    try {
      const { data } = await goalApi.listExecutions(goalId);
      const executions = data?.data || data || [];
      set(s => ({
        goalExecutions: { ...s.goalExecutions, [goalId]: Array.isArray(executions) ? executions : [] },
      }));
    } catch (e) {
      console.error('Failed to load executions:', e);
    }
  },

  cancelExecution: async (goalId, executionId) => {
    await goalApi.cancelExecution(goalId, executionId);
    await get().loadExecutions(goalId);
  },

  retryExecution: async (goalId, executionId) => {
    await goalApi.retryExecution(goalId, executionId);
    await get().loadExecutions(goalId);
  },
}));
