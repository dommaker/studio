// Barrel re-export — 拆分为独立 stores 避免不必要的 re-render
export { useAgentStore } from './agentStore';
export { useRuntimeStore } from './runtimeStore';
export { useUIStore } from './uiStore';
export { useAuthStore } from './authStore';
export { useStepEditorStore } from './stepEditorStore';
export { useGoalStore } from './goalStore';

// 兼容：保留 useAppStore 作为组合导出
import { useAgentStore } from './agentStore';
import { useRuntimeStore } from './runtimeStore';
import { useUIStore } from './uiStore';

export const useAppStore = () => {
  const agents = useAgentStore();
  const runtime = useRuntimeStore();
  const ui = useUIStore();

  return {
    // Agents
    agents: agents.agents,
    selectedAgent: agents.selectedAgent,
    loadAgents: agents.loadAgents,
    selectAgent: agents.selectAgent,

    // Runtime
    runtimeWorkflows: runtime.runtimeWorkflows,
    runtimeExecutions: runtime.runtimeExecutions,
    loadRuntimeWorkflows: runtime.loadRuntimeWorkflows,
    executeRuntimeWorkflow: runtime.executeRuntimeWorkflow,
    loadExecutions: runtime.loadExecutions,
    updateExecution: runtime.updateExecution,
    removeExecution: runtime.removeExecution,

    // UI
    sidebarOpen: ui.sidebarOpen,
    toggleSidebar: ui.toggleSidebar,
  };
};
