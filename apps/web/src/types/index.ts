// 类型定义

// ==================== 执行相关（复用基类）====================

// 执行状态类型（统一）
export type ExecutionStatus = 
  | 'pending' | 'running' | 'paused' | 'succeeded' | 'completed' 
  | 'failed' | 'skipped' | 'stopped' | 'cancelled';

// 基础执行阶段（共同字段）
export interface BaseExecutionPhase {
  id: string;
  name: string;
  status: ExecutionStatus;
  output?: unknown;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

// 角色阶段（含角色信息，用于角色协作流程）
export interface RolePhase extends BaseExecutionPhase {
  role?: string;
}

// 统计阶段（含耗时统计，用于执行统计展示）
export interface StatsPhase extends BaseExecutionPhase {
  duration?: number;
}

// 运行时阶段（最精简，用于运行时状态追踪）
export type RuntimePhase = BaseExecutionPhase;

// 执行记录（后端 API 返回的数据结构）
export interface Execution {
  id: string;
  workflowName?: string;
  status: ExecutionStatus;
  input?: string;
  output?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  steps?: StatsPhase[] | Record<string, RuntimePhase>;
  nodeExecutions?: NodeExecution[];
  currentStep?: number;
  totalSteps?: number;
  projectId?: string;
  projectName?: string;
  requirement?: string;
}

// 执行状态（前端 UI 状态）
export interface ExecutionState {
  id: string;
  skillId?: string;
  input: string;
  status: ExecutionStatus;
  currentStep: number;
  totalSteps: number;
  steps: RolePhase[];
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface NodeExecution {
  nodeId: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
  startTime?: string;
  endTime?: string;
  output?: unknown;
  error?: { code: string; message: string };
}

// ==================== 工作流编辑器相关 ====================

export interface AgentMetadata {
  id: string;
  name: string;
  version: string;
  description?: string;
  category: string;
  icon?: string;
  tags?: string[];
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
  configSchema: JSONSchema;
  timeout?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface JSONSchema {
  type?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  [key: string]: unknown;
}

export interface WorkflowNode {
  id: string;
  name: string;
  agentType: string;
  config?: Record<string, unknown>;
  position?: { x: number; y: number };
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  condition?: { type: string; expression?: string };
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  status: 'draft' | 'published' | 'archived';
  version: number;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  parameters?: unknown[];
  createdAt: string;
  updatedAt: string;
}

// ==================== CEO 指令系统类型 ====================

export interface IntentAnalysis {
  input: string;
  skill: string;
  matchedSkill?: string;
  matchedPipeline?: string;
  confidence: number;
  steps: IntentStep[];
  suggestedPipelines?: PipelineSuggestion[];
  extractedParams: Record<string, unknown>;
  reasoning?: string;
  usedLLM?: boolean;
  usageScenario?: string;
}

export interface IntentStep {
  id: string;
  name: string;
  confidence?: number;
}

export interface PipelineSuggestion {
  id: string;
  name: string;
  description: string;
  confidence: number;
}

// ==================== 思考流类型 ====================

export interface ThinkingMessage {
  id: string;
  executionId: string;
  type: 'step_start' | 'step_progress' | 'step_output' | 'step_complete' | 'thinking' | 'action';
  stepId?: string;
  stepName?: string;
  content?: string;
  progress?: number;
  timestamp: Date;
}
