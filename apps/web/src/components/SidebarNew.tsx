// Sidebar.tsx - 侧边栏组件（最新设计）
// 所有 Execution 都关联 Project，移除独立任务入口
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import '../styles/theme.css';

interface SidebarProps {
  isOpen?: boolean;
  onClose?: () => void;
}

export function Sidebar({ isOpen = true, onClose }: SidebarProps) {
  const { t } = useTranslation();
  const location = useLocation();

  // 首页不显示侧边栏
  if (location.pathname === '/') return null;

  // 导航项
  const navItems = [
    { to: '/', icon: '🏠', label: t('nav.home', '首页') },
    { to: '/pmo', icon: '📊', label: t('nav.pmo', 'PMO') },
    { to: '/knowledge', icon: '📚', label: t('nav.knowledge', '文档') },
    { to: '/wiki', icon: '📖', label: t('nav.wiki', 'Wiki') },
    { to: '/tools', icon: '🔩', label: t('nav.tools', '工具') },
    { to: '/settings', icon: '⚙️', label: t('nav.settings', '设置') },
  ];

  const isActive = (path: string) => {
    if (path === '/') return location.pathname === '/';
    return location.pathname.startsWith(path);
  };

  const handleNavClick = (path: string) => {
    if (onClose && window.innerWidth < 640) {
      onClose();
    }
  };

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
          fontSize: '1.5rem',
          color: 'var(--text-primary)',
          cursor: 'pointer',
        }}
      >
        ✕
      </button>

      {/* 导航列表 */}
      <nav className="p-4 space-y-1">
        {navItems.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            onClick={() => handleNavClick(item.to)}
            className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-all`}
            style={{
              background: isActive(item.to) 
                ? 'linear-gradient(to right, rgba(99, 102, 241, 0.1), rgba(139, 92, 246, 0.1))'
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
        ))}
      </nav>

      {/* 底部状态 */}
      <div className="mt-auto p-4 text-xs" style={{ borderTop: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ background: 'var(--success)' }} />
          <span style={{ color: 'var(--text-muted)' }}>{t('status.ready', '就绪')}</span>
        </div>
      </div>
    </aside>
  );
}