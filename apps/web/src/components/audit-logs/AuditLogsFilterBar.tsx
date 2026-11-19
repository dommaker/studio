// 审计日志筛选栏（AuditLogsPage 抽出，批次 B-5 userId 防抖留在页面）
// 状态与回调全部 props 平移自原页面内联 JSX；#591 来源/主体筛选注释随代码保留
import React from 'react';
import { Select } from '../ui';

export interface AuditLogsFilterState {
  action: string;
  resource: string;
  status: string;
  userId: string;
  source: string;
  actorType: string;
  startDate: string;
  endDate: string;
}

interface Props {
  filters: AuditLogsFilterState;
  /** userId 输入框原值（300ms 防抖后才进 filters，批次 B-5，模式参照 LibraryPage） */
  userIdInput: string;
  actions: string[];
  resources: string[];
  /** 筛选变化统一入口：host 负责改筛选即回第 1 页 */
  onFilterChange: (patch: Partial<AuditLogsFilterState>) => void;
  onUserIdInputChange: (value: string) => void;
}

export const AuditLogsFilterBar: React.FC<Props> = ({
  filters,
  userIdInput,
  actions,
  resources,
  onFilterChange,
  onUserIdInputChange,
}) => (
  <div className="flex items-center gap-4 mb-4 flex-wrap">
    <Select
      aria-label={'操作筛选'}
      value={filters.action}
      onChange={(v) => onFilterChange({ action: v })}
      options={[
        { value: '', label: '全部操作' },
        ...actions.map(action => ({ value: action, label: action })),
      ]}
    />

    <Select
      aria-label={'资源筛选'}
      value={filters.resource}
      onChange={(v) => onFilterChange({ resource: v })}
      options={[
        { value: '', label: '全部资源' },
        ...resources.map(resource => ({ value: resource, label: resource })),
      ]}
    />

    <Select
      aria-label={'状态筛选'}
      value={filters.status}
      onChange={(v) => onFilterChange({ status: v })}
      options={[
        { value: '', label: '全部状态' },
        { value: 'success', label: '成功' },
        { value: 'failure', label: '失败' },
      ]}
    />

    {/* #591：来源筛选（缺省「全部」= all，显式传参覆盖后端缺省 operation） */}
    <Select
      aria-label={'来源筛选'}
      value={filters.source}
      onChange={(v) => onFilterChange({ source: v })}
      options={[
        { value: 'all', label: '全部来源' },
        { value: 'operation', label: '操作日志' },
        { value: 'proposal', label: 'Agent 提案' },
      ]}
    />

    {/* #591：主体筛选（缺省「全部」不传参） */}
    <Select
      aria-label={'主体筛选'}
      value={filters.actorType}
      onChange={(v) => onFilterChange({ actorType: v })}
      options={[
        { value: '', label: '全部主体' },
        { value: 'human', label: '人' },
        { value: 'agent', label: 'Agent' },
      ]}
    />

    <input
      type="text"
      placeholder={'用户 ID'}
      value={userIdInput}
      onChange={(e) => onUserIdInputChange(e.target.value)}
      className="input"
    />

    <input
      type="date"
      aria-label={'开始日期'}
      value={filters.startDate}
      onChange={(e) => onFilterChange({ startDate: e.target.value })}
      className="input"
    />

    <input
      type="date"
      aria-label={'结束日期'}
      value={filters.endDate}
      onChange={(e) => onFilterChange({ endDate: e.target.value })}
      className="input"
    />
  </div>
);
