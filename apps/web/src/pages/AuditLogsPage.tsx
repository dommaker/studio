/**
 * 审计日志页面 - AR-012
 * 
 * 提供审计日志查询、筛选、导出功能
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getApiBase } from '../utils/api';

interface AuditLog {
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

interface AuditLogStats {
  totalLogs: number;
  successCount: number;
  failureCount: number;
  topActions: Array<{ action: string; count: number }>;
  topResources: Array<{ resource: string; count: number }>;
  topUsers: Array<{ userId: string; count: number }>;
  dailyStats: Array<{ date: string; count: number }>;
}

export const AuditLogsPage: React.FC = () => {
  const { t } = useTranslation();
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [stats, setStats] = useState<AuditLogStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedLog, setSelectedLog] = useState<AuditLog | null>(null);

  // Filters
  const [filters, setFilters] = useState({
    action: '',
    resource: '',
    status: '',
    userId: '',
  });
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const limit = 50;

  // Available options
  const [actions, setActions] = useState<string[]>([]);
  const [resources, setResources] = useState<string[]>([]);

  useEffect(() => {
    loadOptions();
    loadLogs();
    loadStats();
  }, [filters, page]);

  const loadOptions = async () => {
    try {
      const apiBase = getApiBase();
      const [actionsRes, resourcesRes] = await Promise.all([
        fetch(`${apiBase}/audit-logs/actions`),
        fetch(`${apiBase}/audit-logs/resources`),
      ]);
      const actionsData = await actionsRes.json();
      const resourcesData = await resourcesRes.json();
      setActions(actionsData.data || []);
      setResources(resourcesData.data || []);
    } catch (err) {
      console.error('Failed to load options:', err);
    }
  };

  const loadLogs = async () => {
    try {
      setLoading(true);
      const apiBase = getApiBase();
      const params = new URLSearchParams();
      if (filters.action) params.set('action', filters.action);
      if (filters.resource) params.set('resource', filters.resource);
      if (filters.status) params.set('status', filters.status);
      if (filters.userId) params.set('userId', filters.userId);
      params.set('page', String(page));
      params.set('limit', String(limit));

      const response = await fetch(`${apiBase}/audit-logs?${params}`);
      const data = await response.json();

      setLogs(data.data || []);
      setTotal(data.pagination?.total || 0);
      setError(null);
    } catch (err: any) {
      setError(err.message || '加载失败');
    } finally {
      setLoading(false);
    }
  };

  const loadStats = async () => {
    try {
      const apiBase = getApiBase();
      const response = await fetch(`${apiBase}/audit-logs/stats`);
      const data = await response.json();
      setStats(data);
    } catch (err) {
      console.error('Failed to load stats:', err);
    }
  };

  const handleExport = async () => {
    try {
      const params = new URLSearchParams();
      if (filters.action) params.set('action', filters.action);
      if (filters.resource) params.set('resource', filters.resource);
      if (filters.userId) params.set('userId', filters.userId);

      window.open(`${getApiBase()}/audit-logs/export?${params}`, '_blank');
    } catch (err) {
      console.error('Export failed:', err);
    }
  };

  const getStatusBadge = (status: string) => {
    const styles: Record<string, string> = {
      success: 'bg-green-100 text-green-700',
      failure: 'bg-red-100 text-red-700',
    };
    return (
      <span className={`px-2 py-1 rounded text-xs font-medium ${styles[status] || 'bg-gray-100 text-gray-700'}`}>
        {status}
      </span>
    );
  };

  const getActionBadge = (action: string) => {
    const colors: Record<string, string> = {
      create: 'bg-blue-100 text-blue-700',
      update: 'bg-yellow-100 text-yellow-700',
      delete: 'bg-red-100 text-red-700',
      execute: 'bg-purple-100 text-purple-700',
      login: 'bg-green-100 text-green-700',
      logout: 'bg-gray-100 text-gray-700',
      purchase: 'bg-indigo-100 text-indigo-700',
    };
    return (
      <span className={`px-2 py-1 rounded text-xs font-medium ${colors[action] || 'bg-gray-100 text-gray-700'}`}>
        {action}
      </span>
    );
  };

  if (loading && !logs.length) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">{t('common.loading')}</div>
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold">📋 {t('auditLogs.title', '审计日志')}</h1>
        <p className="text-gray-600">{t('auditLogs.subtitle', '查看系统操作记录')}</p>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-4 gap-4 mb-6">
          <div className="bg-blue-50 rounded-lg p-4">
            <div className="text-2xl font-bold text-blue-600">{stats.totalLogs}</div>
            <div className="text-sm text-blue-600">{t('auditLogs.stats.total', '总日志数')}</div>
          </div>
          <div className="bg-green-50 rounded-lg p-4">
            <div className="text-2xl font-bold text-green-600">{stats.successCount}</div>
            <div className="text-sm text-green-600">{t('auditLogs.stats.success', '成功操作')}</div>
          </div>
          <div className="bg-red-50 rounded-lg p-4">
            <div className="text-2xl font-bold text-red-600">{stats.failureCount}</div>
            <div className="text-sm text-red-600">{t('auditLogs.stats.failure', '失败操作')}</div>
          </div>
          <div className="bg-purple-50 rounded-lg p-4">
            <div className="text-2xl font-bold text-purple-600">
              {stats.successCount > 0 ? ((stats.successCount / stats.totalLogs) * 100).toFixed(1) : 0}%
            </div>
            <div className="text-sm text-purple-600">{t('auditLogs.stats.successRate', '成功率')}</div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-4 mb-4">
        <select
          value={filters.action}
          onChange={(e) => setFilters({ ...filters, action: e.target.value })}
          className="px-3 py-2 border rounded-lg text-sm"
        >
          <option value="">{t('auditLogs.filters.allActions', '全部操作')}</option>
          {actions.map(action => (
            <option key={action} value={action}>{action}</option>
          ))}
        </select>

        <select
          value={filters.resource}
          onChange={(e) => setFilters({ ...filters, resource: e.target.value })}
          className="px-3 py-2 border rounded-lg text-sm"
        >
          <option value="">{t('auditLogs.filters.allResources', '全部资源')}</option>
          {resources.map(resource => (
            <option key={resource} value={resource}>{resource}</option>
          ))}
        </select>

        <select
          value={filters.status}
          onChange={(e) => setFilters({ ...filters, status: e.target.value })}
          className="px-3 py-2 border rounded-lg text-sm"
        >
          <option value="">{t('auditLogs.filters.allStatus', '全部状态')}</option>
          <option value="success">{t('auditLogs.status.success', '成功')}</option>
          <option value="failure">{t('auditLogs.status.failure', '失败')}</option>
        </select>

        <input
          type="text"
          placeholder={t('auditLogs.filters.userIdPlaceholder', '用户 ID')}
          value={filters.userId}
          onChange={(e) => setFilters({ ...filters, userId: e.target.value })}
          className="px-3 py-2 border rounded-lg text-sm"
        />

        <button
          onClick={handleExport}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700"
        >
          {t('auditLogs.export', '导出')}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 text-red-600 px-4 py-2 rounded mb-4">
          {error}
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b">
              <th className="text-left py-3 px-4 text-sm font-medium text-gray-600">
                {t('auditLogs.table.time', '时间')}
              </th>
              <th className="text-left py-3 px-4 text-sm font-medium text-gray-600">
                {t('auditLogs.table.action', '操作')}
              </th>
              <th className="text-left py-3 px-4 text-sm font-medium text-gray-600">
                {t('auditLogs.table.resource', '资源')}
              </th>
              <th className="text-left py-3 px-4 text-sm font-medium text-gray-600">
                {t('auditLogs.table.user', '用户')}
              </th>
              <th className="text-left py-3 px-4 text-sm font-medium text-gray-600">
                {t('auditLogs.table.status', '状态')}
              </th>
              <th className="text-left py-3 px-4 text-sm font-medium text-gray-600">
                {t('auditLogs.table.ip', 'IP')}
              </th>
              <th className="text-left py-3 px-4 text-sm font-medium text-gray-600">
                {t('auditLogs.table.details', '详情')}
              </th>
            </tr>
          </thead>
          <tbody>
            {logs.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-center py-8 text-gray-500">
                  {t('auditLogs.empty', '暂无审计日志')}
                </td>
              </tr>
            ) : (
              logs.map(log => (
                <tr key={log.id} className="border-b hover:bg-gray-50 cursor-pointer" onClick={() => setSelectedLog(log)}>
                  <td className="py-3 px-4 text-sm">
                    {new Date(log.createdAt).toLocaleString()}
                  </td>
                  <td className="py-3 px-4">
                    {getActionBadge(log.action)}
                  </td>
                  <td className="py-3 px-4 text-sm">
                    {log.resource}
                    {log.resourceId && <span className="text-gray-400 ml-1">({log.resourceId.slice(0, 8)})</span>}
                  </td>
                  <td className="py-3 px-4 text-sm">
                    {log.userId || log.roleId || '-'}
                  </td>
                  <td className="py-3 px-4">
                    {getStatusBadge(log.status)}
                  </td>
                  <td className="py-3 px-4 text-sm text-gray-500">
                    {log.ipAddress || '-'}
                  </td>
                  <td className="py-3 px-4 text-sm text-gray-500">
                    {log.errorMessage ? (
                      <span className="text-red-600" title={log.errorMessage}>
                        {log.errorMessage.slice(0, 30)}...
                      </span>
                    ) : (
                      <button className="text-blue-600 hover:underline">
                        {t('auditLogs.viewDetails', '查看')}
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {total > limit && (
        <div className="flex items-center justify-between mt-4">
          <div className="text-sm text-gray-500">
            {t('auditLogs.pagination', { page, total: Math.ceil(total / limit) })}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
              className="px-3 py-1 border rounded text-sm disabled:opacity-50"
            >
              {t('common.previous')}
            </button>
            <button
              onClick={() => setPage(p => p + 1)}
              disabled={page * limit >= total}
              className="px-3 py-1 border rounded text-sm disabled:opacity-50"
            >
              {t('common.next')}
            </button>
          </div>
        </div>
      )}

      {/* Detail Modal */}
      {selectedLog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-2xl w-full max-h-[80vh] overflow-auto">
            <h2 className="text-xl font-bold mb-4">{t('auditLogs.detail.title', '日志详情')}</h2>
            
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm text-gray-500">{t('auditLogs.detail.id', 'ID')}</label>
                  <div className="font-mono text-sm">{selectedLog.id}</div>
                </div>
                <div>
                  <label className="text-sm text-gray-500">{t('auditLogs.detail.time', '时间')}</label>
                  <div className="text-sm">{new Date(selectedLog.createdAt).toLocaleString()}</div>
                </div>
                <div>
                  <label className="text-sm text-gray-500">{t('auditLogs.detail.action', '操作')}</label>
                  <div>{getActionBadge(selectedLog.action)}</div>
                </div>
                <div>
                  <label className="text-sm text-gray-500">{t('auditLogs.detail.resource', '资源')}</label>
                  <div className="text-sm">{selectedLog.resource}</div>
                </div>
                <div>
                  <label className="text-sm text-gray-500">{t('auditLogs.detail.user', '用户')}</label>
                  <div className="text-sm">{selectedLog.userId || selectedLog.roleId || '-'}</div>
                </div>
                <div>
                  <label className="text-sm text-gray-500">{t('auditLogs.detail.status', '状态')}</label>
                  <div>{getStatusBadge(selectedLog.status)}</div>
                </div>
              </div>

              {selectedLog.details && Object.keys(selectedLog.details).length > 0 && (
                <div>
                  <label className="text-sm text-gray-500 block mb-1">{t('auditLogs.detail.details', '操作详情')}</label>
                  <pre className="bg-gray-100 p-3 rounded text-xs overflow-auto max-h-40">
                    {JSON.stringify(selectedLog.details, null, 2)}
                  </pre>
                </div>
              )}

              {selectedLog.changes && (selectedLog.changes.before || selectedLog.changes.after) && (
                <div>
                  <label className="text-sm text-gray-500 block mb-1">{t('auditLogs.detail.changes', '变更记录')}</label>
                  <div className="grid grid-cols-2 gap-4">
                    {selectedLog.changes.before && (
                      <div>
                        <div className="text-xs text-gray-400 mb-1">{t('auditLogs.detail.before', '变更前')}</div>
                        <pre className="bg-red-50 p-2 rounded text-xs overflow-auto max-h-32">
                          {JSON.stringify(selectedLog.changes.before, null, 2)}
                        </pre>
                      </div>
                    )}
                    {selectedLog.changes.after && (
                      <div>
                        <div className="text-xs text-gray-400 mb-1">{t('auditLogs.detail.after', '变更后')}</div>
                        <pre className="bg-green-50 p-2 rounded text-xs overflow-auto max-h-32">
                          {JSON.stringify(selectedLog.changes.after, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {selectedLog.errorMessage && (
                <div>
                  <label className="text-sm text-red-500 block mb-1">{t('auditLogs.detail.error', '错误信息')}</label>
                  <div className="bg-red-50 p-3 rounded text-sm text-red-700">
                    {selectedLog.errorMessage}
                  </div>
                </div>
              )}
            </div>

            <button
              onClick={() => setSelectedLog(null)}
              className="mt-4 px-4 py-2 bg-gray-100 text-gray-600 rounded hover:bg-gray-200"
            >
              {t('common.close')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default AuditLogsPage;