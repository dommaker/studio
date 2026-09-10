/**
 * 审计日志页面 - AR-012
 * 
 * 提供审计日志查询、筛选、导出功能
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { auditLogApi, type AuditLog, type AuditLogStats } from '../api/auditLogs';
import { Select, Modal } from '../components/ui';
import { formatFullTime } from '../utils/datetime';

/** 日期 input（YYYY-MM-DD）→ 本地日界 ISO，传后端 startTime/endTime */
const toStartIso = (d: string) => (d ? new Date(`${d}T00:00:00`).toISOString() : undefined);
const toEndIso = (d: string) => (d ? new Date(`${d}T23:59:59.999`).toISOString() : undefined);

export const AuditLogsPage: React.FC = () => {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [stats, setStats] = useState<AuditLogStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedLog, setSelectedLog] = useState<AuditLog | null>(null);

  // Filters（startDate/endDate 为日期 input 原值 YYYY-MM-DD，请求时转 ISO）
  const [filters, setFilters] = useState({
    action: '',
    resource: '',
    status: '',
    userId: '',
    startDate: '',
    endDate: '',
  });
  // userId 输入框原值（300ms 防抖后才进 filters，批次 B-5，模式参照 LibraryPage）
  const [userIdInput, setUserIdInput] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const limit = 50;

  // Available options
  const [actions, setActions] = useState<string[]>([]);
  const [resources, setResources] = useState<string[]>([]);

  // 筛选/翻页变化时在渲染期同步置回加载态（替代原 loadLogs 内、由 effect 触发的同步 setLoading）
  const filterKey = JSON.stringify([filters, page]);
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey);
  if (prevFilterKey !== filterKey) {
    setPrevFilterKey(filterKey);
    setLoading(true);
  }

  // 筛选变化统一入口：改筛选即回第 1 页（修复翻页后改筛选停留旧页、结果错位）
  const applyFilter = (patch: Partial<typeof filters>) => {
    setFilters(f => ({ ...f, ...patch }));
    setPage(1);
  };

  // userId 防抖：跳过首次运行（初始加载由主 effect 触发，输入框初值与 filters 一致无需提交）
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstDebounceRef = useRef(true);
  useEffect(() => {
    if (firstDebounceRef.current) {
      firstDebounceRef.current = false;
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      applyFilter({ userId: userIdInput });
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [userIdInput]);

  const loadOptions = useCallback(async () => {
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
  }, []);

  const loadLogs = useCallback(async () => {
    try {
      const response = await auditLogApi.list({
        action: filters.action || undefined,
        resource: filters.resource || undefined,
        status: filters.status || undefined,
        userId: filters.userId || undefined,
        startTime: toStartIso(filters.startDate),
        endTime: toEndIso(filters.endDate),
        page,
        limit,
      });
      const data = response.data;

      setLogs(data.data || []);
      setTotal(data.pagination?.total || 0);
      setError(null);
    } catch (err) {
      setError(err.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [filters, page]);

  const loadStats = useCallback(async () => {
    try {
      const response = await auditLogApi.getStats();
      setStats(response.data);
    } catch (err) {
      console.error('Failed to load stats:', err);
    }
  }, []);

  useEffect(() => {
    // 微任务里触发加载：loader 为多 await async 函数，编译器对 effect 内同步调用保守告警
    void Promise.resolve().then(() => {
      loadOptions();
      loadLogs();
      loadStats();
    });
  }, [loadOptions, loadLogs, loadStats]);

  const handleExport = () => {
    // 文件下载：浏览器跳转打开导出 URL（鉴权说明见 api/auditLogs.ts getExportUrl）
    // 口径与列表一致：status/时间范围随筛选带上
    window.open(auditLogApi.getExportUrl({
      action: filters.action || undefined,
      resource: filters.resource || undefined,
      status: filters.status || undefined,
      userId: filters.userId || undefined,
      startTime: toStartIso(filters.startDate),
      endTime: toEndIso(filters.endDate),
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
        <div className="u-text-2">{'加载中...'}</div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col u-page-bg">
      {/* Header */}
      <div className="u-page-head">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="page-title">{'审计日志'}</h1>
            <p className="page-subtitle">{'查看系统操作记录'}</p>
          </div>
          <button
            onClick={handleExport}
            className="btn btn-primary"
          >
            {'导出'}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto px-8 pb-8">
      <div className="max-w-5xl">

      {/* Stats */}
      {stats && (
        <>
          <div className="mc-block-label">{'概览'}</div>
          <div className="grid grid-cols-4 gap-4 mb-6">
            <StatCard label={'总日志数'} value={stats.totalLogs} color="u-accent" />
            <StatCard label={'成功操作'} value={stats.successCount} color="u-ok" />
            <StatCard label={'失败操作'} value={stats.failureCount} color="u-err" />
            <StatCard
              label={'成功率'}
              value={`${stats.successCount > 0 ? ((stats.successCount / stats.totalLogs) * 100).toFixed(1) : 0}%`}
              color="u-accent"
            />
          </div>
        </>
      )}

      {/* Filters */}
      <div className="mc-block-label">{'筛选'}</div>
      <div className="flex items-center gap-4 mb-4 flex-wrap">
        <Select
          aria-label={'操作筛选'}
          value={filters.action}
          onChange={(v) => applyFilter({ action: v })}
          options={[
            { value: '', label: '全部操作' },
            ...actions.map(action => ({ value: action, label: action })),
          ]}
        />

        <Select
          aria-label={'资源筛选'}
          value={filters.resource}
          onChange={(v) => applyFilter({ resource: v })}
          options={[
            { value: '', label: '全部资源' },
            ...resources.map(resource => ({ value: resource, label: resource })),
          ]}
        />

        <Select
          aria-label={'状态筛选'}
          value={filters.status}
          onChange={(v) => applyFilter({ status: v })}
          options={[
            { value: '', label: '全部状态' },
            { value: 'success', label: '成功' },
            { value: 'failure', label: '失败' },
          ]}
        />

        <input
          type="text"
          placeholder={'用户 ID'}
          value={userIdInput}
          onChange={(e) => setUserIdInput(e.target.value)}
          className="input"
        />

        <input
          type="date"
          aria-label={'开始日期'}
          value={filters.startDate}
          onChange={(e) => applyFilter({ startDate: e.target.value })}
          className="input"
        />

        <input
          type="date"
          aria-label={'结束日期'}
          value={filters.endDate}
          onChange={(e) => applyFilter({ endDate: e.target.value })}
          className="input"
        />
      </div>

      {/* Error */}
      {error && (
        <div className="u-err-dim u-err px-4 py-2 rounded mb-4">
          {error}
        </div>
      )}

      {/* Table */}
      <div className="mc-block-label">{'日志'}</div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b u-border">
              <th className="text-left py-3 px-4 text-sm font-medium u-text-2">
                {'时间'}
              </th>
              <th className="text-left py-3 px-4 text-sm font-medium u-text-2">
                {'操作'}
              </th>
              <th className="text-left py-3 px-4 text-sm font-medium u-text-2">
                {'资源'}
              </th>
              <th className="text-left py-3 px-4 text-sm font-medium u-text-2">
                {'用户'}
              </th>
              <th className="text-left py-3 px-4 text-sm font-medium u-text-2">
                {'状态'}
              </th>
              <th className="text-left py-3 px-4 text-sm font-medium u-text-2">
                {'IP'}
              </th>
              <th className="text-left py-3 px-4 text-sm font-medium u-text-2">
                {'详情'}
              </th>
            </tr>
          </thead>
          <tbody>
            {logs.length === 0 ? (
              <tr>
                <td colSpan={7}>
                  <div className="empty-state">{'暂无审计日志'}</div>
                </td>
              </tr>
            ) : (
              logs.map(log => (
                <tr
                  key={log.id}
                  className="border-b u-border u-hover-bg cursor-pointer"
                  tabIndex={0}
                  onClick={() => setSelectedLog(log)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelectedLog(log);
                    }
                  }}
                >
                  <td className="py-3 px-4 text-sm font-mono">
                    {formatFullTime(log.createdAt)}
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
                        {'查看'}
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
            {`第 ${page} 页 / 共 ${Math.ceil(total / limit)} 页`}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
              className="btn btn-secondary btn-sm"
            >
              {'上一页'}
            </button>
            <button
              onClick={() => setPage(p => p + 1)}
              disabled={page * limit >= total}
              className="btn btn-secondary btn-sm"
            >
              {'下一页'}
            </button>
          </div>
        </div>
      )}

      {/* Detail Modal（批次 F-2：手搓弹层归并 ui/Modal——获得遮罩点击关闭/关闭 ✕/Escape/焦点管理） */}
      <Modal
        open={!!selectedLog}
        onClose={() => setSelectedLog(null)}
        title={'日志详情'}
        maxWidth="672px"
        footer={
          <button
            onClick={() => setSelectedLog(null)}
            className="btn btn-secondary"
          >
            {'关闭'}
          </button>
        }
      >
        {selectedLog && (
          <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm u-text-2">{'ID'}</label>
                  <div className="font-mono text-sm">{selectedLog.id}</div>
                </div>
                <div>
                  <label className="text-sm u-text-2">{'时间'}</label>
                  <div className="font-mono text-sm">{formatFullTime(selectedLog.createdAt)}</div>
                </div>
                <div>
                  <label className="text-sm u-text-2">{'操作'}</label>
                  <div>{getActionBadge(selectedLog.action)}</div>
                </div>
                <div>
                  <label className="text-sm u-text-2">{'资源'}</label>
                  <div className="text-sm">{selectedLog.resource}</div>
                </div>
                <div>
                  <label className="text-sm u-text-2">{'用户'}</label>
                  <div className="text-sm">{selectedLog.userId || selectedLog.roleId || '-'}</div>
                </div>
                <div>
                  <label className="text-sm u-text-2">{'状态'}</label>
                  <div>{getStatusBadge(selectedLog.status)}</div>
                </div>
              </div>

              {selectedLog.details && Object.keys(selectedLog.details).length > 0 && (
                <div>
                  <label className="text-sm u-text-2 block mb-1">{'操作详情'}</label>
                  <pre className="u-surface-2 p-3 rounded text-xs overflow-auto max-h-40">
                    {JSON.stringify(selectedLog.details, null, 2)}
                  </pre>
                </div>
              )}

              {selectedLog.changes && (selectedLog.changes.before || selectedLog.changes.after) && (
                <div>
                  <label className="text-sm u-text-2 block mb-1">{'变更记录'}</label>
                  <div className="grid grid-cols-2 gap-4">
                    {selectedLog.changes.before && (
                      <div>
                        <div className="text-xs u-text-3 mb-1">{'变更前'}</div>
                        <pre className="u-err-dim p-2 rounded text-xs overflow-auto max-h-32">
                          {JSON.stringify(selectedLog.changes.before, null, 2)}
                        </pre>
                      </div>
                    )}
                    {selectedLog.changes.after && (
                      <div>
                        <div className="text-xs u-text-3 mb-1">{'变更后'}</div>
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
                  <label className="text-sm u-err block mb-1">{'错误信息'}</label>
                  <div className="u-err-dim p-3 rounded text-sm u-err">
                    {selectedLog.errorMessage}
                  </div>
                </div>
              )}
            </div>
        )}
      </Modal>
      </div>
      </div>
    </div>
  );
};

/** 统计卡（E7 归一配方：.card 容器 + --fs-stat mono 数字 + u-text-2 标签） */
function StatCard({ label, value, color }: { label: string; value: React.ReactNode; color: string }) {
  return (
    <div className="card p-4">
      <div style={{ fontSize: 'var(--fs-stat)' }} className={`font-mono font-bold ${color}`}>{value}</div>
      <div className="text-sm u-text-2">{label}</div>
    </div>
  );
}

export default AuditLogsPage;