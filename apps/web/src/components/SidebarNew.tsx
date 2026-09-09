// Sidebar.tsx - 侧边栏组件（最新设计）
// #393 菜单精简（spec §2）：主项仅 4 个（频道/PMO/任务/角色，#473 统一「角色」不叫 Agent）；
// 知识库/阅览室/监控/设置/审计日志收进顶部 header「更多」下拉（MoreDropdown），本组件不再有「更多」组
// #395（spec §4.6）：<768 频道左栏（ChannelRail）并入本 sidebar——频道路由下渲染于主导航之下，
// 640–767 随静态 sidebar 常驻、<640 随 sidebar overlay 一起滑出；选频道后 onClose 收起 overlay
// #474 图标策略定稿（全去 emoji）：主导航图标 = components/ui/icons 的 stroke SVG 组件
import { Link, useLocation } from 'react-router-dom';
import type { ComponentType } from 'react';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { ChannelRail } from './channel/ChannelRail';
import { IconChat, IconChart, IconClipboard, IconUsers, type IconProps } from './ui/icons';
import '../styles/theme.css';

interface SidebarProps {
  isOpen?: boolean;
  onClose?: () => void;
}

interface NavItem {
  to: string;
  Icon: ComponentType<IconProps>;
  label: string;
}

const MAIN_ITEMS: NavItem[] = [
  { to: '/channels', Icon: IconChat, label: '频道' },
  { to: '/pmo', Icon: IconChart, label: 'PMO' },
  { to: '/workunits', Icon: IconClipboard, label: '任务' },
  { to: '/agents', Icon: IconUsers, label: '角色' },
];

export function Sidebar({ isOpen = true, onClose }: SidebarProps) {
  const location = useLocation();
  // #395：<768 频道左栏并入（matchMedia 缺失回落宽屏 = 不并入）；activeChannelId 取自路由
  const narrow = useMediaQuery('(max-width: 767px)', false);
  const channelMatch = /^\/channels\/([^/]+)$/.exec(location.pathname);

  const isActive = (path: string) => location.pathname.startsWith(path);

  const handleNavClick = () => {
    if (onClose && window.innerWidth < 640) {
      onClose();
    }
  };

  const renderItem = (item: NavItem) => (
    <Link
      key={item.to}
      to={item.to}
      onClick={() => handleNavClick()}
      className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-all`}
      style={{
        background: isActive(item.to)
          ? 'var(--accent-dim)'
          : 'transparent',
        border: isActive(item.to) ? '1px solid var(--accent-primary)' : '1px solid transparent',
      }}
    >
      {/* #474：emoji 图标 → stroke SVG（currentColor 随 active 态文本色） */}
      <item.Icon size={18} />
      <span className="font-medium" style={{
        color: isActive(item.to) ? 'var(--accent-primary)' : 'var(--text-primary)'
      }}>
        {item.label}
      </span>
    </Link>
  );

  return (
    <aside
      className={`sidebar ${isOpen ? 'sidebar-open' : ''}`}
      style={{
        background: 'var(--bg-secondary)',
        borderRight: '1px solid var(--border-subtle)',
      }}
    >
      {/* 移动端关闭按钮 */}
      <button
        className="mobile-close-btn hide-desktop"
        onClick={onClose}
        aria-label="关闭菜单"
        style={{
          position: 'absolute',
          top: '1rem',
          right: '1rem',
          padding: '0.5rem',
          background: 'transparent',
          border: 'none',
          fontSize: 'var(--fs-title)',
          color: 'var(--text-primary)',
          cursor: 'pointer',
        }}
      >
        ✕
      </button>

      {/* 导航列表 */}
      <nav className="p-4 space-y-1">
        {MAIN_ITEMS.map(renderItem)}
      </nav>

      {/* #395（spec §4.6）：<768 频道左栏并入——工作区内联 ChannelRail 此时已卸载，
          此处为唯一实例；onNavigate 关掉 overlay（静态档 onClose 无副作用） */}
      {narrow && channelMatch && (
        <ChannelRail activeChannelId={channelMatch[1]} onNavigate={onClose} />
      )}
    </aside>
  );
}
