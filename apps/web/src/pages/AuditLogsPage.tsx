/**
 * 审计日志页面 - AR-012
 * 
 * 提供审计日志查询、筛选、导出功能
 */

import React, { useEffect, useRef, useState } from 'react';
import { auditLogApi, type AuditLog } from '../api/auditLogs';
import { useAsyncData } from '../hooks/useAsyncData';
import { Select, SkeletonText, SkeletonCard } from '../components/ui';
import { IconSearch } from '../components/ui/icons';
import { toast } from '../utils/toast';
import { formatFullTime } from '../utils/datetime';

/** 日期 input（YYYY-MM-DD）→ 本地日界 ISO，传后端 startTime/endTime */
const toStartIso = (d: string) => (d ? new Date(`${d}T00:00:00`).toISOString() : undefined);
const toEndIso = (d: string) => (d ? new Date(`${d}T23:59:59.999`).toISOString() : undefined);

const PAGE_LIMIT = 50;

export const AuditLogsPage: React.FC = () => {
  // 行内展开详情：点击行在下方展开/收起，不弹 Modal 遮罩列表
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const toggleExpanded = (id: string) => setExpandedId(cur => (cur === id ? null : id));

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

  // #549（B5 收口）：取数状态机退位——三份 useAsyncData（logs 随筛选/翻页重拉、
  // stats 与下拉 options 挂载一次）；自管理 loading 派生（filterKey prev-state hack）已删；
  // 筛选/翻页/行展开/userId 防抖留页面本地
  // 2026-09 web-ux-optional-fixes Step 1：stats/options 失败不再 try/catch 静默落 null——
  // error 由 hook 承接，各自区块内渲染最小错误行 + 重试（logs 错误条同款 u-err-dim 红条）
  const logsData = useAsyncData(async () => {
    const response = await auditLogApi.list({
      action: filters.action || undefined,
      resource: filters.resource || undefined,
      status: filters.status || undefined,
      userId: filters.userId || undefined,
      startTime: toStartIso(filters.startDate),
      endTime: toEndIso(filters.endDate),
      page,
      limit: PAGE_LIMIT,
    });
    return {
      logs: (response.data.data || []) as AuditLog[],
      total: response.data.pagination?.total || 0,
    };
  }, [filters.action, filters.resource, filters.status, filters.userId, filters.startDate, filters.endDate, page]);

  const statsData = useAsyncData(async () => (await auditLogApi.getStats()).data, []);

  const optionsData = useAsyncData(async () => {
    const [actionsRes, resourcesRes] = await Promise.all([
      auditLogApi.listActions(),
      auditLogApi.listResources(),
    ]);
    return { actions: (actionsRes.data.data || []) as string[], resources: (resourcesRes.data.data || []) as string[] };
  }, []);

  const logs = logsData.data?.logs ?? [];
  const total = logsData.data?.total ?? 0;
  const error = logsData.error;
  const stats = statsData.data;
  const actions = optionsData.data?.actions ?? [];
  const resources = optionsData.data?.resources ?? [];

  // 筛选变化统一入口：改筛选即回第 1 页（修复翻页后改筛选停留旧页、结果错位）
  const applyFilter = (patch: Partial<typeof filters>) => {
    setFilters(f => ({ ...f, ...patch }));
    setPage(1);
  };

  // 批次 F-4：空态双语境——有任一筛选生效时走「筛选无结果」语境 + 清除入口
  const hasActiveFilters = Boolean(
    filters.action || filters.resource || filters.status || filters.userId || filters.startDate || filters.endDate,
  );
  const clearFilters = () => {
    setUserIdInput('');
    setFilters({ action: '', resource: '', status: '', userId: '', startDate: '', endDate: '' });
    setPage(1);
  };

  // userId 防抖：跳过首次运行（初始加载由 useAsyncData 首拉触发，输入框初值与 filters 一致无需提交）
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

  const handleExport = () => {
    // 文件下载：浏览器跳转打开导出 URL（鉴权说明见 api/auditLogs.ts getExportUrl）
    // 口径与列表一致：status/时间范围随筛选带上
    // 批次 F-4：点击反馈——弹窗被拦截/异常时 toast 感知，成功给短暂确认
    const url = auditLogApi.getExportUrl({
      action: filters.action || undefined,
      resource: filters.resource || undefined,
      status: filters.status || undefined,
      userId: filters.userId || undefined,
      startTime: toStartIso(filters.startDate),
      endTime: toEndIso(filters.endDate),
    });
    try {
      const win = window.open(url, '_blank');
      if (win) {
        toast.success('导出已开始，请在浏览器下载中查看');
      } else {
        toast.error('浏览器拦截了导出弹窗，请允许本站点弹出窗口后重试');
      }
    } catch (err) {
      console.error('Failed to export audit logs:', err);
      toast.error('导出失败，请重试');
    }
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

  if (logsData.loading && !logs.length) {
    // 批次 F-3：加载态骨架（批次 E-2 ui/Skeleton 正本）——统计卡 4 格 + 表格行形态
    return (
      <div className="h-full flex flex-col u-page-bg">
        <div className="u-page-head">
          <SkeletonText lines={1} widths={['20%']} />
        </div>
        <div className="flex-1 overflow-auto u-page-px pb-8">
          <div className="max-w-5xl">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
              <SkeletonCard height={88} />
              <SkeletonCard height={88} />
              <SkeletonCard height={88} />
              <SkeletonCard height={88} />
            </div>
            <SkeletonText lines={8} className="space-y-3" />
          </div>
        </div>
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

      <div className="flex-1 overflow-auto u-page-px pb-8">
      <div className="max-w-5xl">

      {/* Stats —— stats 子拉取失败：错误行 + 重试（原 try/catch 只 console.error，统计区凭空消失） */}
      {statsData.error ? (
        <div className="mb-4 p-3 rounded u-err-dim u-err text-sm flex items-center justify-between">
          <span>{statsData.error}</span>
          <button onClick={() => statsData.reload()} className="btn btn-secondary btn-sm">{'重试'}</button>
        </div>
      ) : stats && (
        <>
          <div className="mc-block-label">{'概览'}</div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
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

      {/* Options 子拉取失败：筛选下拉凭空缺项——错误行 + 重试（原 try/catch 只 console.error） */}
      {optionsData.error && (
        <div className="mb-4 p-3 rounded u-err-dim u-err text-sm flex items-center justify-between">
          <span>{optionsData.error}</span>
          <button onClick={() => optionsData.reload()} className="btn btn-secondary btn-sm">{'重试'}</button>
        </div>
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

      {/* Error —— 批次 F-4：错误条补重试（PMOPage u-err-dim 红条 + 重试正本） */}
      {error && (
        <div className="mb-4 p-3 rounded u-err-dim u-err text-sm flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => logsData.reload()} className="btn btn-secondary btn-sm">{'重试'}</button>
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
            {logs.length === 0 && !error && (
              <tr>
                <td colSpan={7}>
                  {/* 批次 F-4：空态归 .empty-state 正本，区分「真空 vs 筛选无结果」（WorkUnitListPage 双语境模式） */}
                  <div className="empty-state">
                    <div className="empty-icon"><IconSearch size={32} /></div>
                    {hasActiveFilters ? (
                      <>
                        <p>{'没有符合当前筛选条件的日志'}</p>
                        <p className="text-sm mt-2">{'调整或清除筛选条件后再查看'}</p>
                        <button className="btn btn-primary mt-4" onClick={clearFilters}>{'清除筛选'}</button>
                      </>
                    ) : (
                      <>
                        <p>{'暂无审计日志'}</p>
                        <p className="text-sm mt-2">{'系统操作产生后会自动记录在这里'}</p>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            )}
            {logs.map(log => (
              <React.Fragment key={log.id}>
                <tr
                  className="border-b u-border u-hover-bg cursor-pointer"
                  tabIndex={0}
                  aria-expanded={expandedId === log.id}
                  onClick={() => toggleExpanded(log.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      toggleExpanded(log.id);
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
                  {/* 批次 I-6：查看/收起非独立按钮——整行（tr）即展开开关（onClick + Enter/Space + aria-expanded），
                      原 <button> 无自身 onClick 只是行点击的视觉提示，改 span 去掉冗余 button 语义/重复 tab 停点 */}
                  <td className="py-3 px-4 text-sm u-text-2">
                    {log.errorMessage ? (
                      <span className="u-err" title={log.errorMessage}>
                        {log.errorMessage.slice(0, 30)}...
                      </span>
                    ) : (
                      <span className="u-accent hover:underline">
                        {expandedId === log.id ? '收起' : '查看'}
                      </span>
                    )}
                  </td>
                </tr>
                {expandedId === log.id && (
                  <tr className="border-b u-border">
                    <td colSpan={7} className="py-4 px-4 u-surface-2">
                      <div className="space-y-4">
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <label className="text-sm u-text-2">{'ID'}</label>
                            <div className="font-mono text-sm">{log.id}</div>
                          </div>
                          <div>
                            <label className="text-sm u-text-2">{'时间'}</label>
                            <div className="font-mono text-sm">{formatFullTime(log.createdAt)}</div>
                          </div>
                          <div>
                            <label className="text-sm u-text-2">{'操作'}</label>
                            <div>{getActionBadge(log.action)}</div>
                          </div>
                          <div>
                            <label className="text-sm u-text-2">{'资源'}</label>
                            <div className="text-sm">{log.resource}</div>
                          </div>
                          <div>
                            <label className="text-sm u-text-2">{'用户'}</label>
                            <div className="text-sm">{log.userId || log.roleId || '-'}</div>
                          </div>
                          <div>
                            <label className="text-sm u-text-2">{'状态'}</label>
                            <div>{getStatusBadge(log.status)}</div>
                          </div>
                        </div>

                        {log.details && Object.keys(log.details).length > 0 && (
                          <div>
                            <label className="text-sm u-text-2 block mb-1">{'操作详情'}</label>
                            <pre className="u-page-bg p-3 rounded text-xs overflow-auto max-h-40">
                              {JSON.stringify(log.details, null, 2)}
                            </pre>
                          </div>
                        )}

                        {log.changes && (log.changes.before || log.changes.after) && (
                          <div>
                            <label className="text-sm u-text-2 block mb-1">{'变更记录'}</label>
                            <div className="grid grid-cols-2 gap-4">
                              {log.changes.before && (
                                <div>
                                  <div className="text-xs u-text-3 mb-1">{'变更前'}</div>
                                  <pre className="u-err-dim p-2 rounded text-xs overflow-auto max-h-32">
                                    {JSON.stringify(log.changes.before, null, 2)}
                                  </pre>
                                </div>
                              )}
                              {log.changes.after && (
                                <div>
                                  <div className="text-xs u-text-3 mb-1">{'变更后'}</div>
                                  <pre className="u-ok-dim p-2 rounded text-xs overflow-auto max-h-32">
                                    {JSON.stringify(log.changes.after, null, 2)}
                                  </pre>
                                </div>
                              )}
                            </div>
                          </div>
                        )}

                        {log.errorMessage && (
                          <div>
                            <label className="text-sm u-err block mb-1">{'错误信息'}</label>
                            <div className="u-err-dim p-3 rounded text-sm u-err">
                              {log.errorMessage}
                            </div>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {total > PAGE_LIMIT && (
        <div className="flex items-center justify-between mt-4">
          <div className="text-sm u-text-2">
            {`第 ${page} 页 / 共 ${Math.ceil(total / PAGE_LIMIT)} 页`}
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
              disabled={page * PAGE_LIMIT >= total}
              className="btn btn-secondary btn-sm"
            >
              {'下一页'}
            </button>
          </div>
        </div>
      )}

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