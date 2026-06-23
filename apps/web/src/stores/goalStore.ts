/**
 * @deprecated Phase 3 LOW: Goal store 正在迁移到 WorkUnit store。
 * 本文件保留兼容性，Phase 3 HIGH 将替换为 useWorkUnitStore。
 * → stores/workUnitStore.ts
 */
import { create } from 'zustand';
import { goalApi } from '../api';

/** @deprecated → WorkUnitExecution 接口（Phase 3 HIGH 迁移时定义） */
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

/** @deprecated → WorkUnit 接口（Phase 3 HIGH 迁移时定义） */
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

/** @deprecated → WorkUnitState 接口（Phase 3 HIGH 迁移时定义） */
interface GoalState {
  goals: Goal[];
  goalExecutions: Record<string, GoalExecution[]>;
  stats: { totalGoals: number; activeGoals: number; completedGoals: number; runningGoalExecutions: number } | null;
  /** @deprecated → useWorkUnitStore.loadWorkUnits() */
  loadGoals: (companyId?: string) => Promise<void>;
  /** @deprecated → useWorkUnitStore.loadStats() */
  loadStats: (companyId?: string) => Promise<void>;
  /** @deprecated → useWorkUnitStore.loadExecutions() */
  loadExecutions: (goalId: string) => Promise<void>;
  /** @deprecated → useWorkUnitStore.cancelExecution() */
  cancelExecution: (goalId: string, executionId: string) => Promise<void>;
  /** @deprecated → useWorkUnitStore.retryExecution() */
  retryExecution: (goalId: string, executionId: string) => Promise<void>;
}

/** @deprecated Phase 3 LOW → 使用 useWorkUnitStore 替代 */
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
