// Audit Logs API — 审计日志查询/统计/导出（AR-012，收编自 AuditLogsPage 裸 fetch）
// 契约驱动迁移（2026-10 批次 6/7）：手抄 interface 全删改 contract import——
// AuditLog 为归一后消费形状（details/changes 恒对象），AuditLogRow 为 wire 行
// （details/changes 落盘 JSON 串）；GET /stats 裸对象进 { data } 壳。
import { api } from './index';
import type {
  AuditLog,
  AuditLogStats,
  AuditLogQuery,
  AuditLogRow,
  PaginatedBody,
} from '@dommaker/studio-contract';

export type { AuditLog, AuditLogStats, AuditLogQuery };

/**
 * 后端行 details/changes 存 JSON 字符串（AuditLogRow 落盘形状），前端消费类型
 * 声明为对象（contract AuditLog）——此处归一（容错坏串落 undefined），
 * 消费方（详情展开 diff/详情块）拿到的恒为对象。
 */
function parseJsonField<T>(raw: unknown): T | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as T; } catch { return undefined; }
  }
  return raw as T;
}

function normalizeRow(log: AuditLogRow): AuditLog {
  return {
    ...log,
    details: parseJsonField<AuditLog['details']>(log.details),
    changes: parseJsonField<AuditLog['changes']>(log.changes),
  } as AuditLog;
}

export const auditLogApi = {
  list: async (params?: AuditLogQuery) => {
    const res = await api.get<PaginatedBody<AuditLogRow>>('/audit-logs', { params });
    return { ...res, data: { ...res.data, data: res.data.data.map(normalizeRow) } };
  },
  getStats: () => api.get<{ data: AuditLogStats }>('/audit-logs/stats'),
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
