// Audit Logs API — 审计日志查询/统计/导出（AR-012，收编自 AuditLogsPage 裸 fetch）
import { api } from './index';

export interface AuditLog {
  id: string;
  userId?: string;
  roleId?: string;
  companyId?: string;
  ipAddress?: string;
  userAgent?: string;
  action: string;
  resource: string;
  resourceId?: string;
  details?: Record<string, unknown>;
  changes?: {
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    fields?: string[];
  };
  status: string;
  /** #591：操作主体；存量行无此字段（视为 human） */
  actorType?: 'human' | 'agent';
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
}

export interface AuditLogStats {
  totalLogs: number;
  successCount: number;
  failureCount: number;
  topActions: Array<{ action: string; count: number }>;
  topResources: Array<{ resource: string; count: number }>;
  topUsers: Array<{ userId: string; count: number }>;
  dailyStats: Array<{ date: string; count: number }>;
}

export interface AuditLogQuery {
  action?: string;
  resource?: string;
  status?: string;
  userId?: string;
  /** #591：主体过滤（human 归一匹配存量无字段行） */
  actorType?: 'human' | 'agent';
  /** #591：来源过滤；后端缺省 operation，「全部」需显式传 all */
  source?: 'operation' | 'proposal' | 'all';
  /** ISO 8601；后端 list/stats/export 原生支持（routes.ts 已读参） */
  startTime?: string;
  endTime?: string;
  page?: number;
  limit?: number;
}

/** 分页响应包（对应后端 formatPaginatedResponse） */
interface AuditLogListResponse {
  data: AuditLog[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

export const auditLogApi = {
  list: (params?: AuditLogQuery) =>
    api.get<AuditLogListResponse>('/audit-logs', { params }),
  getStats: () => api.get<AuditLogStats>('/audit-logs/stats'),
  listActions: () => api.get<{ data: string[] }>('/audit-logs/actions'),
  listResources: () => api.get<{ data: string[] }>('/audit-logs/resources'),
  /**
   * 导出为文件下载 URL（浏览器跳转触发下载）。
   * 正当绕开 axios：window.open 无法携带 Authorization 头，鉴权依赖 cookie（withCredentials 同源会话）。
   */
  getExportUrl: (params?: AuditLogQuery): string => {
    const search = new URLSearchParams();
    if (params?.action) search.set('action', params.action);
    if (params?.resource) search.set('resource', params.resource);
    if (params?.status) search.set('status', params.status);
    if (params?.userId) search.set('userId', params.userId);
    if (params?.actorType) search.set('actorType', params.actorType);
    if (params?.source) search.set('source', params.source);
    if (params?.startTime) search.set('startTime', params.startTime);
    if (params?.endTime) search.set('endTime', params.endTime);
    const qs = search.toString();
    return `${api.defaults.baseURL}/audit-logs/export${qs ? `?${qs}` : ''}`;
  },
};
