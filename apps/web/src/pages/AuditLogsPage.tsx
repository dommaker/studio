/**
 * 审计日志页面 - AR-012
 *
 * 提供审计日志查询、筛选、导出功能
 * 筛选栏/表格子组件在 components/audit-logs/（本文件只留数据接线 + 区块编排）
 */

import React, { useEffect, useRef, useState } from 'react';
import { auditLogApi, type AuditLog } from '../api/auditLogs';
import { useAsyncData } from '../hooks/useAsyncData';
import { SkeletonText, SkeletonCard, StatCard } from '../components/ui';
import { toast } from '../utils/toast';
import { AuditLogsFilterBar, type AuditLogsFilterState } from '../components/audit-logs/AuditLogsFilterBar';
import { AuditLogsTable } from '../components/audit-logs/AuditLogsTable';

/** 日期 input（YYYY-MM-DD）→ 本地日界 ISO，传后端 startTime/endTime */
const toStartIso = (d: string) => (d ? new Date(`${d}T00:00:00`).toISOString() : undefined);
const toEndIso = (d: string) => (d ? new Date(`${d}T23:59:59.999`).toISOString() : undefined);

const PAGE_LIMIT = 50;

export const AuditLogsPage: React.FC = () => {
  // 行内展开详情：点击行在下方展开/收起，不弹 Modal 遮罩列表
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const toggleExpanded = (id: string) => setExpandedId(cur => (cur === id ? null : id));

  // Filters（startDate/endDate 为日期 input 原值 YYYY-MM-DD，请求时转 ISO）
  // #591：source 缺省 'all'（「全部」；后端缺省 operation，需显式传）；actorType '' = 不传
  const [filters, setFilters] = useState<AuditLogsFilterState>({
    action: '',
    resource: '',
    status: '',
    userId: '',
    source: 'all',
    actorType: '',
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
      source: filters.source as 'operation' | 'proposal' | 'all',
      actorType: (filters.actorType || undefined) as 'human' | 'agent' | undefined,
      startTime: toStartIso(filters.startDate),
      endTime: toEndIso(filters.endDate),
      page,
      limit: PAGE_LIMIT,
    });
    return {
      logs: (response.data.data || []) as AuditLog[],
      total: response.data.pagination?.total || 0,
    };
  }, [filters.action, filters.resource, filters.status, filters.userId, filters.source, filters.actorType, filters.startDate, filters.endDate, page]);

  // GET /stats 进 { data } 壳（契约驱动批次 6/7）→ .data.data 解包
  const statsData = useAsyncData(async () => (await auditLogApi.getStats()).data.data, []);

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
    filters.action || filters.resource || filters.status || filters.userId ||
    filters.actorType || filters.source !== 'all' ||
    filters.startDate || filters.endDate,
  );
  const clearFilters = () => {
    setUserIdInput('');
    setFilters({ action: '', resource: '', status: '', userId: '', source: 'all', actorType: '', startDate: '', endDate: '' });
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
      source: filters.source as 'operation' | 'proposal' | 'all',
      actorType: (filters.actorType || undefined) as 'human' | 'agent' | undefined,
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
      <AuditLogsFilterBar
        filters={filters}
        userIdInput={userIdInput}
        actions={actions}
        resources={resources}
        onFilterChange={applyFilter}
        onUserIdInputChange={setUserIdInput}
      />

      {/* Error —— 批次 F-4：错误条补重试（PMOPage u-err-dim 红条 + 重试正本） */}
      {error && (
        <div className="mb-4 p-3 rounded u-err-dim u-err text-sm flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => logsData.reload()} className="btn btn-secondary btn-sm">{'重试'}</button>
        </div>
      )}

      {/* Table */}
      <div className="mc-block-label">{'日志'}</div>
      <AuditLogsTable
        logs={logs}
        error={error}
        expandedId={expandedId}
        hasActiveFilters={hasActiveFilters}
        onToggleExpanded={toggleExpanded}
        onClearFilters={clearFilters}
      />

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
