// 审计日志表格（AuditLogsPage 抽出）：行内展开详情 + 双语境空态 + 徽章
// 行展开状态（expandedId）由 host 持有；批次 F-4 空态 / 批次 I-6 整行即展开开关注释随代码保留
import React from 'react';
import type { AuditLog } from '../../api/auditLogs';
import { IconSearch } from '../ui/icons';
import { formatFullTime } from '../../utils/datetime';

interface Props {
  logs: AuditLog[];
  /** logs 拉取失败时的错误文案（非空时空态行不渲染） */
  error: string | null;
  expandedId: string | null;
  /** 批次 F-4：有任一筛选生效时空态走「筛选无结果」语境 */
  hasActiveFilters: boolean;
  onToggleExpanded: (id: string) => void;
  onClearFilters: () => void;
}

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

export const AuditLogsTable: React.FC<Props> = ({
  logs,
  error,
  expandedId,
  hasActiveFilters,
  onToggleExpanded,
  onClearFilters,
}) => (
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
                    <button className="btn btn-primary mt-4" onClick={onClearFilters}>{'清除筛选'}</button>
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
              onClick={() => onToggleExpanded(log.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onToggleExpanded(log.id);
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
                {/* #591：agent 行主体标识（存量行无 actorType 视为 human，不显示） */}
                {log.actorType === 'agent' && (
                  <span className="ml-1 px-1.5 py-0.5 rounded text-xs font-medium u-accent-dim u-accent">{'Agent'}</span>
                )}
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
);
