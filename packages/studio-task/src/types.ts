// CLI 命令选项和输出类型

export interface TaskListItem {
  id: string;
  company: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  createdAt: Date;
  completedAt?: Date;
}

export interface QueueOptions { company: string; status?: string; format?: 'table' | 'json'; }
export interface RunOptions { task: string; format?: 'table' | 'json'; }
export interface RetryOptions { task: string; format?: 'table' | 'json'; }
export interface CleanOptions { company: string; days: number; format?: 'table' | 'json'; }