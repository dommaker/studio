// types.ts - Agent Studio 类型定义

// ==================== 执行相关 ====================

// 执行状态类型（统一）
export type ExecutionStatus = 
  | 'pending' | 'running' | 'paused' | 'succeeded' | 'completed' 
  | 'failed' | 'skipped' | 'stopped' | 'cancelled';

// 基础执行阶段（共同字段）
export interface BaseExecutionPhase {
  id: string;
  name: string;
  status: ExecutionStatus;
  output?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

// 执行记录（后端 API 返回的数据结构，合并了原 Execution 和 Execution）
export interface Execution {
  id: string;
  workflowId: string;
  workflowName?: string;
  status: ExecutionStatus;
  input?: string;
  output?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  // 阶段记录（后端字段名为 steps，类型为 Phase 相关）
  steps?: StatsPhase[] | Record<string, RuntimePhase>;
  nodeExecutions?: NodeExecution[];
  // UI 状态
  currentStep?: number;
  totalSteps?: number;
  // 项目信息
  projectId?: string;
  projectName?: string;
  requirement?: string;
}

export interface NodeExecution {
  id: string;
  nodeId: string;
  nodeName?: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  input?: any;
  output?: any;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

// 角色阶段（含角色信息，用于角色协作流程）
export interface RolePhase extends BaseExecutionPhase {
  role?: string;
}

// 执行状态（前端 UI 状态，用于 UI 组件）
export interface ExecutionState {
  id: string;
  skillId?: string;
  input: string;
  status: ExecutionStatus;
  currentStep: number;
  totalSteps: number;
  steps: RolePhase[];  // 角色协作的阶段
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

// 统计阶段（含耗时统计，用于执行统计展示）
export interface StatsPhase extends BaseExecutionPhase {
  duration?: number;
}

// 运行时阶段（最精简，用于运行时状态追踪）
export type RuntimePhase = BaseExecutionPhase;

export interface ThinkingMessage {
  id: string;
  executionId: string;
  type: 'step_start' | 'step_complete' | 'thinking' | 'error';
  stepId?: string;
  stepName?: string;
  content?: string;
  progress?: number;
  timestamp: Date;
}

export interface IntentAnalysis {
  input: string;
  skill: string;
  confidence: number;
  steps: { id: string; name: string; confidence?: number }[];
  extractedParams: Record<string, any>;
  reasoning?: string;
  usedLLM?: boolean;
  matchedSkill?: string;
  matchedWorkflow?: string;
  suggestedPipelines?: SuggestedPipeline[];
}

export interface SuggestedPipeline {
  id: string;
  name: string;
  confidence?: number;
  description?: string;
}

// ==================== 角色系统 ====================

export interface Role {
  id: string;
  name: string;
  type: string;
  avatar?: string;
  companyId: string;

  // 能力（关联）
  roleCapabilities?: RoleCapability[];

  // 状态
  status: 'active' | 'on_leave' | 'resigned';
  
  // 元数据
  createdAt: string;
  updatedAt: string;
}

// 创建角色的输入参数
export interface CreateRoleInput {
  name: string;
  type: string;
  companyId: string;
  level?: number;
  personality?: {
    prompt: string;
    traits: string[];
  };
  salary?: number;
  initialCapabilities?: string[];
}

export interface Company {
  id: string;
  name: string;
  size?: string;
  roles?: Role[];
  createdAt: string;
  updatedAt?: string;
}

export interface Capability {
  id: string;
  name: string;
  type: 'tool' | 'step' | 'workflow' | 'skill';
  category?: string;
  description?: string;
  cost?: number;
  path?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface RoleCapability {
  id: string;
  roleId: string;
  capabilityId: string;
  source: 'initial' | 'learned' | 'created' | 'inherited';
  createdAt: string;
}

export interface Performance {
  id: string;
  roleId: string;
  month: string;  // YYYY-MM
  tasksCount: number;
  qualityAvg: number;
  satisfaction: number;
  notes?: string;
  createdAt: string;
}

export interface PerformanceStats {
  totalTasks: number;
  avgQuality: number;
  satisfactionRate: number;
  monthlyTrend: Array<{
    month: string;
    tasks: number;
    quality: number;
    satisfaction: number;
  }>;
}

// ==================== Agent/Workflow ====================

export interface Agent {
  id: string;
  name: string;
  version: string;
  category: string;
  description?: string;
  icon?: string;
  tags?: string[];
  timeout?: number;
  createdAt?: string;
}

export interface AgentMetadata {
  id: string;
  name: string;
  description?: string;
  version?: string;
  category?: string;
  icon?: string;
  capabilities?: string[];
  config?: Record<string, any>;
  inputSchema?: JSONSchema;
  outputSchema?: JSONSchema;
}

export interface JSONSchema {
  type?: string;
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
  title?: string;
  description?: string;
  // Allow common schema properties
  default?: any;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  pattern?: string;
  format?: string;
  maxLength?: number;
}

export interface JSONSchemaProperty {
  type: string;
  description?: string;
  default?: any;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  pattern?: string;
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  steps: WorkflowStep[];
  triggers?: WorkflowTrigger[];
  nodes?: WorkflowNode[];
  edges?: WorkflowEdge[];
  status?: 'draft' | 'active' | 'archived';
  version?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface WorkflowNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: Record<string, any>;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  type?: string;
  label?: string;
}

export interface WorkflowStep {
  id: string;
  name: string;
  agentId?: string;
  type?: string;
  config?: Record<string, any>;
  timeout?: number;
}

export interface WorkflowTrigger {
  type: 'manual' | 'schedule' | 'event';
  config?: Record<string, any>;
}

// ==================== 项目 ====================

export interface Project {
  id: string;
  name: string;
  path: string;
  status?: string;
  createdAt: string;
  updatedAt?: string;
}

// ==================== 会议室系统 ====================

export interface Meeting {
  id: string;
  title: string;
  description?: string;
  status: 'pending' | 'discussing' | 'pending_confirmation' | 'summarizing' | 'completed' | 'cancelled';
  topic?: string;
  
  // 结果
  summary?: string;
  decisions?: Array<{
    content: string;
    agreed: boolean;
    roles: string[];
  }>;
  
  // 配置
  mode: 'sync' | 'async';
  maxRounds: number;
  
  // 超时配置
  autoEndMinutes: number;
  responseTimeout: number;
  
  companyId: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  
  // 关联
  participants?: MeetingParticipant[];
  messages?: MeetingMessage[];
  _count?: {
    messages: number;
  };
}

export interface MeetingParticipant {
  id: string;
  meetingId: string;
  roleId: string;
  stance: string;
  status: 'invited' | 'joined' | 'speaking' | 'completed';
  joinedAt?: string;
  
  // 锁定状态
  locked: boolean;
  lockedBy?: string;
  lockedAt?: string;
  
  // 关联
  role?: Role;
}

export interface MeetingMessage {
  id: string;
  meetingId: string;
  participantId?: string;
  roleId: string;
  
  // 消息内容
  content: string;
  messageType: 'speech' | 'system' | 'decision';
  round: number;
  
  // 立场信息
  stance?: string;
  
  // 元数据
  metadata?: Record<string, any>;
  createdAt: string;
  
  // 关联
  role?: Role;
}
// PipelineStep 类型（兼容）
export type PipelineStep = WorkflowStep;
