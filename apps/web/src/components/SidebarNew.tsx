// Sidebar.tsx - 侧边栏组件（最新设计）
// #393 菜单精简（spec §2）：主项仅 4 个（频道/PMO/WorkUnit/Agent），
// 知识库/阅览室/监控/设置/审计日志收进「更多」展开组
import { useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import '../styles/theme.css';

interface SidebarProps {
  isOpen?: boolean;
  onClose?: () => void;
}

interface NavItem {
  to: string;
  icon: string;
  label: string;
}

const MAIN_ITEMS: NavItem[] = [
  { to: '/channels', icon: '💬', label: '频道' },
  { to: '/pmo', icon: '📊', label: 'PMO' },
  { to: '/workunits', icon: '📋', label: 'WorkUnit' },
  { to: '/agents', icon: '🤖', label: 'Agent' },
];

const MORE_ITEMS: NavItem[] = [
  { to: '/knowledge', icon: '📚', label: '知识库' },
  { to: '/library', icon: '📖', label: '阅览室' },
  { to: '/monitoring', icon: '📈', label: '监控' },
  { to: '/settings', icon: '⚙️', label: '设置' },
  { to: '/audit-logs', icon: '🔍', label: '审计日志' },
];

export function Sidebar({ isOpen = true, onClose }: SidebarProps) {
  const location = useLocation();

  const isActive = (path: string) => location.pathname.startsWith(path);
  const moreActive = MORE_ITEMS.some(item => isActive(item.to));
  // 当前路由落在收纳项时默认展开，其余折叠
  const [moreOpen, setMoreOpen] = useState(moreActive);
  // sidebar 常驻不卸载：站内跳转进收纳路由时同步展开（只自动展开、不自动收起，保留手动折叠自由）
  useEffect(() => { if (moreActive) setMoreOpen(true); }, [moreActive]);

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
      <span className="text-lg">{item.icon}</span>
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

        {/* 更多（收纳项） */}
        <button
          type="button"
          onClick={() => setMoreOpen(!moreOpen)}
          aria-expanded={moreOpen}
          className="flex items-center gap-3 px-3 py-2 rounded-lg transition-all w-full"
          style={{
            background: 'transparent',
            border: '1px solid transparent',
            cursor: 'pointer',
            color: moreActive ? 'var(--accent-primary)' : 'var(--text-primary)',
          }}
        >
          <span className="text-lg">⋯</span>
          <span className="font-medium">更多</span>
          <span className="ml-auto text-xs" style={{ color: 'var(--text-muted)' }}>
            {moreOpen ? '▼' : '▶'}
          </span>
        </button>
        {moreOpen && MORE_ITEMS.map(renderItem)}
      </nav>

      {/* 底部状态 */}
      <div className="mt-auto p-4 text-xs" style={{ borderTop: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ background: 'var(--success)' }} />
          <span style={{ color: 'var(--text-muted)' }}>就绪</span>
        </div>
      </div>
    </aside>
  );
}
