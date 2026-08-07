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
  details?: Record<string, any>;
  changes?: {
    before?: Record<string, any>;
    after?: Record<string, any>;
    fields?: string[];
  };
  status: string;
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
    if (params?.userId) search.set('userId', params.userId);
    const qs = search.toString();
    return `${api.defaults.baseURL}/audit-logs/export${qs ? `?${qs}` : ''}`;
  },
};
