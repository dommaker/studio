// workflowEditorStore.ts - Workflow 编辑器状态管理
import { create } from 'zustand';
import { stepApi, runtimeWorkflowApi } from '../api';
import type { Position, Node, Edge } from '../types/canvas';
import type { Workflow } from '../types';

export type { Position, Node, Edge };

// Skill 类型（ToolStdPanel 使用）
export interface Skill {
  id: string;
  name: string;
  description: string;
  agent?: 'codex' | 'claude';
  category?: string;
}

// Step 类型（WorkflowEditor 使用）
export interface Step {
  id: string;
  name: string;
  description: string;
  skill?: string;
  step?: string;
  category?: string;
  agent?: 'codex' | 'claude';
  tools?: string[];
  toolIds?: string[];
  nodes?: Node[];
  edges?: Edge[];
  createdAt?: string;
  updatedAt?: string;
}

// 工作流信息
export interface WorkflowInfo {
  id: string;
  name: string;
  description?: string;
  openclaw?: {
    emoji?: string;
    userInvocable?: boolean;
    keywords?: string[];
  };
  steps?: Step[];
  nodes?: Node[];
  edges?: Edge[];
}

// Store 状态
interface WorkflowEditorState {
  // 技能列表
  skills: Skill[];
  skillsLoading: boolean;
  skillsError: string | null;

  // 工作流列表（Sidebar 所需）
  workflows: Workflow[];
  selectedWorkflow: Workflow | null;

  // 工作流编辑器
  workflow: WorkflowInfo | null;

  // 画布
  nodes: Node[];
  edges: Edge[];

  // Actions
  loadSkills: () => Promise<void>;
  loadSteps: () => Promise<void>;
  loadWorkflow: (id: string) => Promise<void>;
  loadWorkflows: () => Promise<void>;
  selectWorkflow: (wf: Workflow | null) => void;
  createWorkflow: (name: string) => Promise<Workflow>;
}

export const useWorkflowEditorStore = create<WorkflowEditorState>((set, get) => ({
  skills: [],
  skillsLoading: false,
  skillsError: null,

  workflows: [],
  selectedWorkflow: null,
  workflow: null,

  nodes: [],
  edges: [],

  loadSkills: async () => {
    set({ skillsLoading: true, skillsError: null });
    try {
      const { data } = await runtimeWorkflowApi.listSkills();
      const list = data?.data || data?.skills || data || [];
      const skills: Skill[] = (Array.isArray(list) ? list : []).map((s: any) => ({
        id: s.id || s.name,
        name: s.name || s.id,
        description: s.description || '',
        agent: s.agent || 'claude',
        category: s.category,
      }));
      set({ skills, skillsLoading: false });
    } catch (error) {
      const msg = error instanceof Error ? error.message : '加载技能失败';
      set({ skillsError: msg, skillsLoading: false });
    }
  },

  loadWorkflows: async () => {
    try {
      const { data } = await runtimeWorkflowApi.listWorkflows();
      const list = data?.data || data || [];
      const workflows: Workflow[] = Array.isArray(list) ? list : [];
      set({ workflows });
    } catch (error) {
      console.error('Failed to load workflows:', error);
      set({ workflows: [] });
    }
  },

  selectWorkflow: (wf) => {
    set({ selectedWorkflow: wf });
  },

  createWorkflow: async (name: string) => {
    const newWorkflow: Workflow = {
      id: `wf-${Date.now()}`,
      name,
      description: '',
      status: 'draft',
      version: '1',
      steps: [],
      nodes: [],
      edges: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    set((state) => ({
      workflows: [...state.workflows, newWorkflow],
    }));
    return newWorkflow;
  },

  loadSteps: async () => {
    try {
      const { data } = await stepApi.list();
      // steps loaded into workflow as needed
    } catch (error) {
      console.error('Failed to load steps:', error);
    }
  },

  loadWorkflow: async (id: string) => {
    try {
      const { data } = await runtimeWorkflowApi.get(id);
      const wf = data?.workflow || data;
      set({
        workflow: {
          id: wf.id,
          name: wf.name || '',
          description: wf.description,
          openclaw: wf.openclaw,
          steps: wf.steps,
        },
      });
    } catch (error) {
      console.error('Failed to load workflow:', error);
      set({ workflow: null });
    }
  },
}));
