// ProjectDetailPage 的页面级领域类型（Task / Execution / Project）
// 随 project-detail 组件抽取从页面搬出，字段保持原样
import type { StatsPhase, NodeExecution } from '../../types';

export interface Task {
  id: string;
  name: string;
  description?: string;
  assignee: string;
  priority: string;
  status: string;
  claimedBy?: string;
  claimedAt?: string;
  dependsOn: string[];
  acceptanceCriteria: string[];
  estimatedHours?: number;
  createdAt: string;
  ClaimedBy?: { id: string; name: string; type: string };
}

export interface Execution {
  id: string;
  status: string;
  workflowName?: string;
  parameters?: any;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  steps?: StatsPhase[];
  currentStep?: number;
  totalSteps?: number;
  nodeExecutions?: NodeExecution[];
}

export interface Project {
  id: string;
  pmoNumber: string;
  title: string;
  description?: string;
  requirement?: string;
  status: string;
  priority: string;
  progress: number;
  gitBranch?: string;
  gitRepo?: string;
  // 🆕 PMO-a: REQ 只读别名 / 交付策略 / 杂务标记
  reqAlias?: string | null;
  deliveryPolicy?: string;
  isChore?: boolean;
  channelId?: string | null;
  worktreePath?: string;
  startedAt?: string;
  completedAt?: string;
  deliveredAt?: string | null;
  createdAt: string;
  OKR?: { id: string; title: string; quarter: string };
  Execution?: Execution[];
}
