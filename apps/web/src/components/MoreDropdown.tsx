// MoreDropdown.tsx - "更多"下拉菜单组件（L4 高级功能）
// 左侧 sidebar「更多」收纳项已并入本下拉（知识库/阅览室/监控 + 审计日志/设置；PMO 为 sidebar 四主项之一，不重复收纳）
// #468 徽标投影化：计数徽标 = notificationStore.unreadCount（行动中心未读口径，归零可达）——
// 原 monitoringApi 24h 告警 + 提案待审计数（loadAttentionCount）已删；展开下拉时 load() 刷新。
// #474 图标策略定稿（全去 emoji）：菜单/触发器图标 = components/ui/icons 的 stroke SVG 组件
import { useState, useEffect, useRef, type ComponentType } from 'react';
import { Link } from 'react-router-dom';
import { useNotificationStore } from '../stores/notificationStore';
import { IconBook, IconLibrary, IconActivity, IconSearch, IconSettings, IconGrid, type IconProps } from './ui/icons';
import '../styles/theme.css';

interface DropdownItem {
  to: string;
  Icon: ComponentType<IconProps>;
  label: string;
}

const MORE_ITEMS: DropdownItem[] = [
  { to: '/knowledge', Icon: IconBook, label: '知识库' },
  { to: '/library', Icon: IconLibrary, label: '阅览室' },
  { to: '/monitoring', Icon: IconActivity, label: '监控' },
  { to: '/audit-logs', Icon: IconSearch, label: '审计日志' },
];

const CONFIG_ITEMS: DropdownItem[] = [
  { to: '/settings', Icon: IconSettings, label: '设置' },
];

interface MoreDropdownProps {
  /** 批次 D-2 项 8：「搜索 ⌘K」入口（打开 App 根 CommandPalette）；不传则不渲染该项 */
  onOpenSearch?: () => void;
}

export function MoreDropdown({ onOpenSearch }: MoreDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  // #468：徽标 = 行动中心 unreadCount（同数据源投影，不再单独拉监控计数）；展开时重拉刷新
  const unreadCount = useNotificationStore(s => s.unreadCount);
  const load = useNotificationStore(s => s.load);

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
      <span className="flex items-center"><item.Icon size={16} /></span>
      <span>{item.label}</span>
    </Link>
  );

  return (
    <div ref={dropdownRef} className="relative">
      <button
        onClick={() => {
          const next = !isOpen;
          setIsOpen(next);
          if (next) void load();
        }}
        className="btn btn-ghost relative flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors u-text-2"
      >
        <span className="flex items-center"><IconGrid size={16} /></span>
        <span className="hidden sm:inline">更多</span>
        <span className="text-xs">{isOpen ? '▼' : '▶'}</span>
        {/* #468 计数徽标：绝对定位独立槽位（沿用既有模式），不被 text ellipsis 吞掉 */}
        {unreadCount > 0 && (
          <span
            data-visual-ignore
            title="有未读通知"
            className="absolute -top-1 -right-1 u-err-bg u-on-accent text-[var(--fs-xs)] font-bold rounded-full min-w-4 h-4 px-0.5 flex items-center justify-center"
          >
            {unreadCount > 99 ? '99+' : unreadCount}
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
          {/* 批次 D-2 项 8：「搜索 ⌘K」入口（降低 Cmd/Ctrl+K 学习成本），点击开 App 根 CommandPalette */}
          {onOpenSearch && (
            <>
              <div className="px-2 pb-1">
                <span className="text-xs font-medium px-2 u-text-3">
                  快捷
                </span>
              </div>
              <button
                type="button"
                className="w-full text-left block px-4 py-2 text-sm transition-colors flex items-center gap-2 u-hover-bg u-text"
                onClick={() => {
                  setIsOpen(false);
                  onOpenSearch();
                }}
              >
                <span className="flex items-center"><IconSearch size={16} /></span>
                <span>搜索</span>
                <span className="ml-auto text-xs u-text-3">⌘K</span>
              </button>
              <div className="my-1 mx-2 border-t u-border" />
            </>
          )}
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
