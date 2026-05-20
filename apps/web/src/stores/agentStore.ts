import { create } from 'zustand';
import type { AgentMetadata } from '../types';
import { agentApi } from '../api';

interface AgentState {
  agents: AgentMetadata[];
  selectedAgent: AgentMetadata | null;
  loadAgents: () => Promise<void>;
  selectAgent: (agent: AgentMetadata | null) => void;
}

export const useAgentStore = create<AgentState>((set) => ({
  agents: [],
  selectedAgent: null,
  loadAgents: async () => {
    const { data } = await agentApi.list();
    set({ agents: data.data });
  },
  selectAgent: (agent) => set({ selectedAgent: agent }),
}));
