// Requirement API — REQ 需求编号体系（vision §5.3）
import { api } from './index';

export type RequirementStatus = 'open' | 'in-progress' | 'done' | 'archived';

export interface Requirement {
  id: string;                 // REQ-0042
  seq: number;
  title: string;
  status: RequirementStatus;
  channelId?: string | null;
  createdAt: string;
  createdBy: string;
  docs?: string[];
  description?: string;
  /** B3a 工程归属链：挂接的 PMO 项目 id（后端已返回；WU 详情页归属条经此解析 PMO） */
  projectId?: string | null;
}

export interface RequirementChainWorkUnit {
  id: string;
  title: string;
  status: string;
  assigneeId: string | null;
  metadata?: string | null;  // F6-b：链路节点徽章走 deriveDisplayState
}

export interface RequirementChain {
  requirement: Requirement;
  workunits: RequirementChainWorkUnit[];
}

export const requirementApi = {
  list: (params?: { status?: string; channelId?: string }) =>
    api.get<{ success: boolean; data: Requirement[] }>('/requirements', { params }),

  get: (id: string) =>
    api.get<{ success: boolean; data: Requirement }>(`/requirements/${id}`),

  create: (data: { title: string; channelId?: string; description?: string }) =>
    api.post<{ success: boolean; data: Requirement }>('/requirements', data),

  update: (id: string, data: { title?: string; status?: RequirementStatus; docs?: string[]; description?: string }) =>
    api.patch<{ success: boolean; data: Requirement }>(`/requirements/${id}`, data),

  getChain: (id: string) =>
    api.get<{ success: boolean; data: RequirementChain }>(`/requirements/${id}/chain`),
};
