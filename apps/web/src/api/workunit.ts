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
  reqId?: string | null;
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

/** M2 成本红线度量：agent-loop 写入的 workunit:tokens 事件（payload 解析后） */
export interface WorkunitTokenEvent {
  workUnitId: string;
  executionId?: string;
  /** 注入上下文估算 tokens（chars/4 约定） */
  injectedTokens: number;
  /** 执行总 tokens；CLI 未回报 usage 时为 null（不编造 0） */
  executionTokens: number | null;
  executionSource?: string;
  totalTokens: number;
  createdAt?: string;
}

/**
 * 从 GET /events?type=workunit:tokens 的响应行中解析某个 WorkUnit 的 token 事件。
 * payload 损坏或不属于该 WorkUnit 的行跳过（不计 0，不编造）。
 */
export function parseWorkunitTokenEvents(
  rows: Array<{ payload: unknown; createdAt?: string }>,
  workUnitId: string,
): WorkunitTokenEvent[] {
  const out: WorkunitTokenEvent[] = [];
  for (const row of rows) {
    try {
      const p = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
      if (!p || p.workUnitId !== workUnitId) continue;
      if (typeof p.injectedTokens !== 'number') continue;
      out.push({
        workUnitId: p.workUnitId,
        executionId: p.executionId,
        injectedTokens: p.injectedTokens,
        executionTokens: typeof p.executionTokens === 'number' ? p.executionTokens : null,
        executionSource: p.executionSource,
        totalTokens: typeof p.totalTokens === 'number' ? p.totalTokens : p.injectedTokens,
        createdAt: row.createdAt,
      });
    } catch {
      // 跳过损坏行
    }
  }
  return out;
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

  /** M2: workunit:tokens 度量事件（配合 parseWorkunitTokenEvents 按 WorkUnit 过滤） */
  listTokenEvents: (limit = 200) =>
    api.get<{ events: Array<{ payload: unknown; createdAt?: string }>; total: number }>(
      '/events',
      { params: { type: 'workunit:tokens', limit } },
    ),
};
