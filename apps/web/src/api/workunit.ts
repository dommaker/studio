// WorkUnit API — Agent Network §3.28c-1
import { api } from './index';

export interface WorkUnit {
  id: string;
  parentId: string | null;
  dependsOn: string;
  type: string;
  scope: string;
  assigneeId: string | null;
  status: string;
  failureType: string | null;
  retryCount: number;
  timeoutAt: string | null;
  channelId: string | null;
  metadata: string | null;
  createdAt: string;
  updatedAt: string;
  claimedAt: string | null;
  completedAt: string | null;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

export const workunitApi = {
  list: (params?: {
    type?: string;
    status?: string;
    assigneeId?: string;
    channelId?: string;
    page?: number;
    limit?: number;
  }) => api.get<PaginatedResponse<WorkUnit>>('/workunits', { params }),

  get: (id: string) => api.get<WorkUnit>(`/workunits/${id}`),

  create: (data: {
    scope: string;
    type?: string;
    assigneeId?: string;
    status?: string;
    channelId?: string;
    parentId?: string;
    dependsOn?: string;
    metadata?: string;
  }) => api.post<WorkUnit>('/workunits', data),

  update: (id: string, data: Partial<WorkUnit>) =>
    api.put<WorkUnit>(`/workunits/${id}`, data),

  delete: (id: string) => api.delete(`/workunits/${id}`),

  claim: (id: string, agentId: string) =>
    api.post<WorkUnit>(`/workunits/${id}/claim`, { agentId }),

  unclaim: (id: string) =>
    api.post<WorkUnit>(`/workunits/${id}/unclaim`),

  transitionStatus: (id: string, status: string) =>
    api.post<WorkUnit>(`/workunits/${id}/status`, { status }),

  reviewPassed: (id: string) =>
    api.post<WorkUnit>(`/workunits/${id}/review-passed`),

  reviewRejected: (id: string, reason?: string) =>
    api.post<WorkUnit>(`/workunits/${id}/review-rejected`, { reason }),

  getMessages: (id: string, params?: { before?: string; limit?: number }) =>
    api.get(`/workunits/${id}/messages`, { params }),

  postMessage: (id: string, content: string, authorType?: 'human' | 'agent') =>
    api.post(`/workunits/${id}/messages`, { content, authorType }),
};
