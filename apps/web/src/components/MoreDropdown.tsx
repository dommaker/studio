// MoreDropdown.tsx - "更多"下拉菜单组件（L4 高级功能）
// 左侧 sidebar「更多」收纳项已并入本下拉（知识库/阅览室/监控 + 审计日志/设置；PMO 为 sidebar 四主项之一，不重复收纳）
// E4/B-8 监控入口可见性：有待处理告警/提案时按钮挂计数徽标（监控藏在本下拉内无提示）
import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { monitoringApi } from '../api/monitoring';
import { useAsyncData } from '../hooks/useAsyncData';
import '../styles/theme.css';

interface DropdownItem {
  to: string;
  icon: string;
  label: string;
}

const MORE_ITEMS: DropdownItem[] = [
  { to: '/knowledge', icon: '📚', label: '知识库' },
  { to: '/library', icon: '📖', label: '阅览室' },
  { to: '/monitoring', icon: '📈', label: '监控' },
  { to: '/audit-logs', icon: '🔍', label: '审计日志' },
];

const CONFIG_ITEMS: DropdownItem[] = [
  { to: '/settings', icon: '⚙️', label: '设置' },
];

/**
 * E4/B-8 待处理计数 = 近 24h 告警数（overview.alerts.last24h，与 NeedsAttentionSection 24h 窗口同口径）
 * + 知识提案待审数（flywheel.proposalsPendingReview，与监控页行动面同库口径）。
 * 无专用轻量计数端点——复用两个 60s 服务端缓存的监控端点；各自 best-effort 失败/403（非 Admin）落 0，徽标隐藏。
 */
async function loadAttentionCount(): Promise<number> {
  const [alerts, proposals] = await Promise.all([
    monitoringApi.getOverview().then((r) => r.data.alerts?.last24h ?? 0).catch(() => 0),
    monitoringApi.getFlywheel().then((r) => r.data.proposalsPendingReview ?? 0).catch(() => 0),
  ]);
  return alerts + proposals;
}

export function MoreDropdown() {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  // 挂载首拉 + 展开时重拉（无 SSE 告警事件可接，展开即用户关注时刻，服务端 60s 缓存兜底成本）
  const attentionQ = useAsyncData(loadAttentionCount, []);
  const attention = attentionQ.data ?? 0;

  // 点击外部关闭
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);

  const renderItem = (item: DropdownItem) => (
    <Link
      key={item.to}
      to={item.to}
      className="block px-4 py-2 text-sm transition-colors flex items-center gap-2 u-hover-bg u-text"
      onClick={() => setIsOpen(false)}
    >
      <span>{item.icon}</span>
      <span>{item.label}</span>
    </Link>
  );

  return (
    <div ref={dropdownRef} className="relative">
      <button
        onClick={() => {
          const next = !isOpen;
          setIsOpen(next);
          if (next) attentionQ.reload();
        }}
        className="btn btn-ghost relative flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors u-text-2"
      >
        <span>🗂</span>
        <span className="hidden sm:inline">更多</span>
        <span className="text-xs">{isOpen ? '▼' : '▶'}</span>
        {/* E4/B-8 计数徽标：绝对定位独立槽位（沿用 NotificationBell 模式），不被 text ellipsis 吞掉 */}
        {attention > 0 && (
          <span
            data-visual-ignore
            title="监控有待处理事项"
            className="absolute -top-1 -right-1 u-err-bg u-on-accent text-[var(--fs-xs)] font-bold rounded-full min-w-4 h-4 px-0.5 flex items-center justify-center"
          >
            {attention > 99 ? '99+' : attention}
          </span>
        )}
      </button>

      {isOpen && (
        <div
          className="absolute right-0 top-full mt-1 w-52 rounded-lg py-2 z-50"
          style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-default)',
            boxShadow: 'var(--shadow-lg)',
          }}
        >
          {/* 高级功能 */}
          <div className="px-2 pb-1">
            <span className="text-xs font-medium px-2 u-text-3">
              高级功能
            </span>
          </div>
          {MORE_ITEMS.map(renderItem)}

          <div className="my-1 mx-2 border-t u-border" />

          {/* 配置功能 */}
          <div className="px-2 pb-1">
            <span className="text-xs font-medium px-2 u-text-3">
              配置
            </span>
          </div>
          {CONFIG_ITEMS.map(renderItem)}
        </div>
      )}
    </div>
  );
}