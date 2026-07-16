// stepEditorStore.ts - Step 编辑器状态管理
import { create } from 'zustand';
import { stepApi } from '../api';
import type { Position, Node, Edge } from '../types/canvas';

export type { Position, Node, Edge };

// 工具类型定义
export interface Tool {
  id: string;
  name: string;
  description: string;
  category?: string;
  type: 'tool';
  path?: string;
}

// 步骤类型定义
export interface Step {
  id: string;
  name: string;
  description: string;
  category?: string;
  agent?: 'codex' | 'claude';
  tools?: string[];
  toolIds?: string[];
  nodes?: Node[];
  edges?: Edge[];
  path?: string;
  createdAt?: string;
  updatedAt?: string;
}

// Store 状态接口
interface StepEditorState {
  // 工具相关
  tools: Tool[];
  toolsLoading: boolean;
  toolsError: string | null;
  
  // 步骤相关
  step: Step | null;
  stepLoading: boolean;
  stepError: string | null;
  
  // 保存相关
  saving: boolean;
  saveError: string | null;
  
  // 画布相关
  nodes: Node[];
  edges: Edge[];
  
  // Actions
  loadTools: () => Promise<void>;
  loadStep: (id: string, category?: string) => Promise<void>;
  saveStep: (step: Partial<Step>) => Promise<{ success: boolean; step?: Step; error?: string }>;
  deleteStep: (id: string, category?: string) => Promise<{ success: boolean; error?: string }>;
  setNodes: (nodes: Node[]) => void;
  setEdges: (edges: Edge[]) => void;
  addNode: (node: Node) => void;
  updateNode: (id: string, data: Partial<Node['data']>) => void;
  removeNode: (id: string) => void;
  reset: () => void;
}

// 初始状态
const initialState = {
  tools: [],
  toolsLoading: false,
  toolsError: null,
  step: null,
  stepLoading: false,
  stepError: null,
  saving: false,
  saveError: null,
  nodes: [],
  edges: [],
};

export const useStepEditorStore = create<StepEditorState>((set, get) => ({
  ...initialState,
  
  // 加载工具列表（/tools 已废弃，返回空）
  loadTools: async () => {
    set({ tools: [], toolsLoading: false, toolsError: null });
  },
  
  // 加载步骤详情
  loadStep: async (id: string, category?: string) => {
    set({ stepLoading: true, stepError: null });
    
    try {
      const { data } = await stepApi.get(id, category);
      const step = data.step || data;
      
      // 根据 tools 数组生成节点
      const toolIds = step.tools || step.toolIds || [];
      const nodes: Node[] = [];
      const edges: Edge[] = [];
      
      // 画布居中计算
      const centerX = 300;
      const startY = 50;
      const stepHeight = 120;
      
      // 创建开始节点
      nodes.push({
        id: 'start',
        type: 'custom',
        data: { label: '开始', icon: '▶️' },
        position: { x: centerX, y: startY },
      });
      
      // 为每个工具创建节点
      toolIds.forEach((toolId: string, index: number) => {
        const nodeId = `tool-${toolId}-${index}`;
        
        nodes.push({
          id: nodeId,
          type: 'custom',
          position: { x: centerX, y: startY + (index + 1) * stepHeight },
          data: {
            label: toolId,
            tool: { id: toolId, name: toolId, description: '', type: 'tool' },
          },
        });
        
        // 创建边
        const sourceId = index === 0 ? 'start' : `tool-${toolIds[index - 1]}-${index - 1}`;
        edges.push({
          id: `edge-${sourceId}-${nodeId}`,
          source: sourceId,
          target: nodeId,
          type: 'smoothstep',  // 使用直角连线
        });
      });
      
      set({ 
        step, 
        stepLoading: false,
        nodes,
        edges,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '加载步骤失败';
      set({ stepError: message, stepLoading: false });
    }
  },
  
  // 保存步骤（创建或更新）
  saveStep: async (step: Partial<Step>) => {
    set({ saving: true, saveError: null });
    
    try {
      const { step: currentStep } = get();
      const isUpdate = !!currentStep?.id;
      
      // 从节点提取 toolIds
      const nodes = get().nodes;
      const toolIds = nodes
        .filter(n => n.data?.tool && typeof n.data.tool === 'object' && 'id' in n.data.tool)
        .map(n => (n.data.tool as { id: string }).id);
      
      const stepData = {
        name: step.name || currentStep?.name || '',
        description: step.description || currentStep?.description || '',
        category: step.category || currentStep?.category || 'custom',
        agent: step.agent || currentStep?.agent || 'codex',
        toolIds: step.tools || toolIds,
      };
      
      let response;
      if (isUpdate && currentStep?.id) {
        // 更新
        response = await stepApi.update(currentStep.id, stepData, currentStep.category);
      } else {
        // 创建
        response = await stepApi.create(stepData);
      }
      
      const savedStep = response.data.step || response.data;
      
      set({ 
        step: savedStep, 
        saving: false,
      });
      
      return { success: true, step: savedStep };
    } catch (error) {
      const message = error instanceof Error ? error.message : '保存步骤失败';
      set({ saveError: message, saving: false });
      return { success: false, error: message };
    }
  },
  
  // 删除步骤
  deleteStep: async (id: string, category?: string) => {
    try {
      await stepApi.delete(id, category);
      set({ step: null, nodes: [], edges: [] });
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : '删除步骤失败';
      return { success: false, error: message };
    }
  },
  
  // 设置节点
  setNodes: (nodes) => set({ nodes }),
  
  // 设置边
  setEdges: (edges) => set({ edges }),
  
  // 添加节点
  addNode: (node) => set((state) => ({
    nodes: [...state.nodes, node],
  })),
  
  // 更新节点
  updateNode: (id, data) => set((state) => ({
    nodes: state.nodes.map((node) =>
      node.id === id ? { ...node, data: { ...node.data, ...data } } : node
    ),
  })),
  
  // 删除节点
  removeNode: (id) => set((state) => ({
    nodes: state.nodes.filter((node) => node.id !== id),
    edges: state.edges.filter((edge) => edge.source !== id && edge.target !== id),
  })),
  
  // 重置状态
  reset: () => set(initialState),
}));
