// 类型定义

// ========== Agent ==========
export type AgentCategory = 'llm' | 'tool' | 'workflow' | 'processor' | 'connector' | 'custom';

export interface JSONSchema {
  type?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema | JSONSchema[];
  enum?: any[];
  format?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  default?: any;
  title?: string;
  description?: string;
  additionalProperties?: boolean | JSONSchema;
  'x-sensitive'?: boolean;
  'x-form-type'?: FormType;
  'x-form-options'?: Record<string, any>;
}

export type FormType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'select'
  | 'multiselect'
  | 'checkbox'
  | 'radio'
  | 'switch'
  | 'date'
  | 'time'
  | 'datetime'
  | 'color'
  | 'file'
  | 'code'
  | 'json'
  | 'slider'
  | 'rating'
  | 'password'
  | 'tags';

export interface RetryPolicy {
  maxRetries: number;
  backoff: 'fixed' | 'exponential';
  initialDelay: number;
  maxDelay: number;
}

export interface RateLimit {
  requests: number;
  windowMs: number;
}

export interface AgentMetadata {
  id: string;
  name: string;
  version: string;
  description?: string;
  category: AgentCategory;
  icon?: string;
  tags?: string[];
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
  configSchema: JSONSchema;
  endpoint?: string;
  timeout?: number;
  retryPolicy?: RetryPolicy;
  rateLimit?: RateLimit;
  metadata?: Record<string, any>;
  createdAt?: string;
  updatedAt?: string;
}

// ========== Workflow ==========
export interface WorkflowNode {
  id: string;
  name: string;
  agentType: string;
  config?: Record<string, any>;
  position?: { x: number; y: number };
  retryPolicy?: RetryPolicy;
  timeout?: number;
}

export interface EdgeCondition {
  type: 'success' | 'failure' | 'custom';
  expression?: string;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  condition?: EdgeCondition;
}

export interface WorkflowParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required?: boolean;
  default?: any;
  description?: string;
}

export interface WorkflowDefinition {
  name: string;
  description?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  parameters?: WorkflowParameter[];
  metadata?: Record<string, any>;
}

export interface Workflow extends WorkflowDefinition {
  id: string;
  status: 'draft' | 'published' | 'archived';
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
}

// ========== Execution ==========
export type ExecutionStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type NodeExecutionStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

export interface ExecutionError {
  code: string;
  message: string;
  details?: Record<string, any>;
}

export interface NodeExecution {
  nodeId: string;
  status: NodeExecutionStatus;
  startTime?: string;
  endTime?: string;
  input?: Record<string, any>;
  output?: Record<string, any>;
  error?: ExecutionError;
}

export interface Execution {
  id: string;
  workflowId: string;
  status: ExecutionStatus;
  startTime?: string;
  endTime?: string;
  parameters?: Record<string, any>;
  nodeExecutions?: NodeExecution[];
  error?: ExecutionError;
}

export interface ExecutionRequest {
  parameters?: Record<string, any>;
  async?: boolean;
  priority?: number;
}

// ========== Pagination ==========
export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: Pagination;
}

// ========== Error ==========
export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: Record<string, any>;
  };
}

// ========== Skills Generation ==========
export interface GenerateSkillsResponse {
  count: number;
  message?: string;
}
