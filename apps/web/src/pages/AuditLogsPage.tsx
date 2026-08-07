/**
 * 审计日志页面 - AR-012
 * 
 * 提供审计日志查询、筛选、导出功能
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { auditLogApi, type AuditLog, type AuditLogStats } from '../api/auditLogs';
import { Select } from '../components/ui';

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
      const [actionsRes, resourcesRes] = await Promise.all([
        auditLogApi.listActions(),
        auditLogApi.listResources(),
      ]);
      setActions(actionsRes.data.data || []);
      setResources(resourcesRes.data.data || []);
    } catch (err) {
      console.error('Failed to load options:', err);
    }
  };

  const loadLogs = async () => {
    try {
      setLoading(true);
      const response = await auditLogApi.list({
        action: filters.action || undefined,
        resource: filters.resource || undefined,
        status: filters.status || undefined,
        userId: filters.userId || undefined,
        page,
        limit,
      });
      const data = response.data;

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
      const response = await auditLogApi.getStats();
      setStats(response.data);
    } catch (err) {
      console.error('Failed to load stats:', err);
    }
  };

  const handleExport = () => {
    // 文件下载：浏览器跳转打开导出 URL（鉴权说明见 api/auditLogs.ts getExportUrl）
    window.open(auditLogApi.getExportUrl({
      action: filters.action || undefined,
      resource: filters.resource || undefined,
      userId: filters.userId || undefined,
    }), '_blank');
  };

  const getStatusBadge = (status: string) => {
    const styles: Record<string, string> = {
      success: 'u-ok-dim u-ok',
      failure: 'u-err-dim u-err',
    };
    return (
      <span className={`px-2 py-1 rounded text-xs font-medium ${styles[status] || 'u-surface-2 u-text'}`}>
        {status}
      </span>
    );
  };

  const getActionBadge = (action: string) => {
    const colors: Record<string, string> = {
      create: 'u-accent-dim u-accent',
      update: 'u-warn-dim u-warn',
      delete: 'u-err-dim u-err',
      execute: 'u-accent-dim u-accent',
      login: 'u-ok-dim u-ok',
      logout: 'u-surface-2 u-text',
      purchase: 'u-accent-dim u-accent',
    };
    return (
      <span className={`px-2 py-1 rounded text-xs font-medium ${colors[action] || 'u-surface-2 u-text'}`}>
        {action}
      </span>
    );
  };

  if (loading && !logs.length) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="u-text-2">{t('common.loading')}</div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--bg-primary)' }}>
      {/* Header */}
      <div className="px-8 py-6" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <h1 className="page-title">📋 {t('auditLogs.title', '审计日志')}</h1>
        <p className="page-subtitle">{t('auditLogs.subtitle', '查看系统操作记录')}</p>
      </div>

      <div className="flex-1 overflow-auto px-8 py-6">

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-4 gap-4 mb-6">
          <div className="u-accent-dim rounded p-4">
            <div className="text-2xl font-bold u-accent">{stats.totalLogs}</div>
            <div className="text-sm u-accent">{t('auditLogs.stats.total', '总日志数')}</div>
          </div>
          <div className="u-ok-dim rounded p-4">
            <div className="text-2xl font-bold u-ok">{stats.successCount}</div>
            <div className="text-sm u-ok">{t('auditLogs.stats.success', '成功操作')}</div>
          </div>
          <div className="u-err-dim rounded p-4">
            <div className="text-2xl font-bold u-err">{stats.failureCount}</div>
            <div className="text-sm u-err">{t('auditLogs.stats.failure', '失败操作')}</div>
          </div>
          <div className="u-accent-dim rounded p-4">
            <div className="text-2xl font-bold u-accent">
              {stats.successCount > 0 ? ((stats.successCount / stats.totalLogs) * 100).toFixed(1) : 0}%
            </div>
            <div className="text-sm u-accent">{t('auditLogs.stats.successRate', '成功率')}</div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-4 mb-4">
        <Select
          value={filters.action}
          onChange={(v) => setFilters({ ...filters, action: v })}
          options={[
            { value: '', label: t('auditLogs.filters.allActions', '全部操作') },
            ...actions.map(action => ({ value: action, label: action })),
          ]}
        />

        <Select
          value={filters.resource}
          onChange={(v) => setFilters({ ...filters, resource: v })}
          options={[
            { value: '', label: t('auditLogs.filters.allResources', '全部资源') },
            ...resources.map(resource => ({ value: resource, label: resource })),
          ]}
        />

        <Select
          value={filters.status}
          onChange={(v) => setFilters({ ...filters, status: v })}
          options={[
            { value: '', label: t('auditLogs.filters.allStatus', '全部状态') },
            { value: 'success', label: t('auditLogs.status.success', '成功') },
            { value: 'failure', label: t('auditLogs.status.failure', '失败') },
          ]}
        />

        <input
          type="text"
          placeholder={t('auditLogs.filters.userIdPlaceholder', '用户 ID')}
          value={filters.userId}
          onChange={(e) => setFilters({ ...filters, userId: e.target.value })}
          className="input"
        />

        <button
          onClick={handleExport}
          className="btn btn-primary"
        >
          {t('auditLogs.export', '导出')}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="u-err-dim u-err px-4 py-2 rounded mb-4">
          {error}
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b u-border">
              <th className="text-left py-3 px-4 text-sm font-medium u-text-2">
                {t('auditLogs.table.time', '时间')}
              </th>
              <th className="text-left py-3 px-4 text-sm font-medium u-text-2">
                {t('auditLogs.table.action', '操作')}
              </th>
              <th className="text-left py-3 px-4 text-sm font-medium u-text-2">
                {t('auditLogs.table.resource', '资源')}
              </th>
              <th className="text-left py-3 px-4 text-sm font-medium u-text-2">
                {t('auditLogs.table.user', '用户')}
              </th>
              <th className="text-left py-3 px-4 text-sm font-medium u-text-2">
                {t('auditLogs.table.status', '状态')}
              </th>
              <th className="text-left py-3 px-4 text-sm font-medium u-text-2">
                {t('auditLogs.table.ip', 'IP')}
              </th>
              <th className="text-left py-3 px-4 text-sm font-medium u-text-2">
                {t('auditLogs.table.details', '详情')}
              </th>
            </tr>
          </thead>
          <tbody>
            {logs.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-center py-8 u-text-2">
                  {t('auditLogs.empty', '暂无审计日志')}
                </td>
              </tr>
            ) : (
              logs.map(log => (
                <tr key={log.id} className="border-b u-border u-hover-bg cursor-pointer" onClick={() => setSelectedLog(log)}>
                  <td className="py-3 px-4 text-sm">
                    {new Date(log.createdAt).toLocaleString()}
                  </td>
                  <td className="py-3 px-4">
                    {getActionBadge(log.action)}
                  </td>
                  <td className="py-3 px-4 text-sm">
                    {log.resource}
                    {log.resourceId && <span className="u-text-3 ml-1">({log.resourceId.slice(0, 8)})</span>}
                  </td>
                  <td className="py-3 px-4 text-sm">
                    {log.userId || log.roleId || '-'}
                  </td>
                  <td className="py-3 px-4">
                    {getStatusBadge(log.status)}
                  </td>
                  <td className="py-3 px-4 text-sm u-text-2">
                    {log.ipAddress || '-'}
                  </td>
                  <td className="py-3 px-4 text-sm u-text-2">
                    {log.errorMessage ? (
                      <span className="u-err" title={log.errorMessage}>
                        {log.errorMessage.slice(0, 30)}...
                      </span>
                    ) : (
                      <button className="u-accent hover:underline">
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
          <div className="text-sm u-text-2">
            {t('auditLogs.pagination', { page, total: Math.ceil(total / limit) })}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
              className="btn btn-secondary btn-sm"
            >
              {t('common.previous')}
            </button>
            <button
              onClick={() => setPage(p => p + 1)}
              disabled={page * limit >= total}
              className="btn btn-secondary btn-sm"
            >
              {t('common.next')}
            </button>
          </div>
        </div>
      )}

      {/* Detail Modal */}
      {selectedLog && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 672 }}>
            <div className="modal-header">
              <h2 className="modal-title">{t('auditLogs.detail.title', '日志详情')}</h2>
            </div>
            <div className="modal-body">
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm u-text-2">{t('auditLogs.detail.id', 'ID')}</label>
                  <div className="font-mono text-sm">{selectedLog.id}</div>
                </div>
                <div>
                  <label className="text-sm u-text-2">{t('auditLogs.detail.time', '时间')}</label>
                  <div className="text-sm">{new Date(selectedLog.createdAt).toLocaleString()}</div>
                </div>
                <div>
                  <label className="text-sm u-text-2">{t('auditLogs.detail.action', '操作')}</label>
                  <div>{getActionBadge(selectedLog.action)}</div>
                </div>
                <div>
                  <label className="text-sm u-text-2">{t('auditLogs.detail.resource', '资源')}</label>
                  <div className="text-sm">{selectedLog.resource}</div>
                </div>
                <div>
                  <label className="text-sm u-text-2">{t('auditLogs.detail.user', '用户')}</label>
                  <div className="text-sm">{selectedLog.userId || selectedLog.roleId || '-'}</div>
                </div>
                <div>
                  <label className="text-sm u-text-2">{t('auditLogs.detail.status', '状态')}</label>
                  <div>{getStatusBadge(selectedLog.status)}</div>
                </div>
              </div>

              {selectedLog.details && Object.keys(selectedLog.details).length > 0 && (
                <div>
                  <label className="text-sm u-text-2 block mb-1">{t('auditLogs.detail.details', '操作详情')}</label>
                  <pre className="u-surface-2 p-3 rounded text-xs overflow-auto max-h-40">
                    {JSON.stringify(selectedLog.details, null, 2)}
                  </pre>
                </div>
              )}

              {selectedLog.changes && (selectedLog.changes.before || selectedLog.changes.after) && (
                <div>
                  <label className="text-sm u-text-2 block mb-1">{t('auditLogs.detail.changes', '变更记录')}</label>
                  <div className="grid grid-cols-2 gap-4">
                    {selectedLog.changes.before && (
                      <div>
                        <div className="text-xs u-text-3 mb-1">{t('auditLogs.detail.before', '变更前')}</div>
                        <pre className="u-err-dim p-2 rounded text-xs overflow-auto max-h-32">
                          {JSON.stringify(selectedLog.changes.before, null, 2)}
                        </pre>
                      </div>
                    )}
                    {selectedLog.changes.after && (
                      <div>
                        <div className="text-xs u-text-3 mb-1">{t('auditLogs.detail.after', '变更后')}</div>
                        <pre className="u-ok-dim p-2 rounded text-xs overflow-auto max-h-32">
                          {JSON.stringify(selectedLog.changes.after, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {selectedLog.errorMessage && (
                <div>
                  <label className="text-sm u-err block mb-1">{t('auditLogs.detail.error', '错误信息')}</label>
                  <div className="u-err-dim p-3 rounded text-sm u-err">
                    {selectedLog.errorMessage}
                  </div>
                </div>
              )}
            </div>
            </div>
            <div className="modal-footer">
              <button
                onClick={() => setSelectedLog(null)}
                className="btn btn-secondary"
              >
                {t('common.close')}
              </button>
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
};

export default AuditLogsPage;