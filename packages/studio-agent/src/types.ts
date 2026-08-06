// studio-agent 类型定义

export type AgentCategory = 'llm' | 'tool' | 'processor' | 'connector' | 'custom';

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
}

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