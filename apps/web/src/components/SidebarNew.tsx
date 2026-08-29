// Sidebar.tsx - 侧边栏组件（最新设计）
// 所有 Execution 都关联 Project，移除独立任务入口
import { Link, useLocation } from 'react-router-dom';
import '../styles/theme.css';

interface SidebarProps {
  isOpen?: boolean;
  onClose?: () => void;
}

export function Sidebar({ isOpen = true, onClose }: SidebarProps) {
  const location = useLocation();

  // 导航项
  const navItems = [
    { to: '/channels', icon: '💬', label: '频道' },
    { to: '/pmo', icon: '📊', label: 'PMO' },
    { to: '/knowledge', icon: '📚', label: '知识库' },
    { to: '/library', icon: '📖', label: '阅览室' },
    { to: '/workunits', icon: '📋', label: 'WorkUnit' },
    { to: '/agents', icon: '🤖', label: 'Agent' },
    { to: '/monitoring', icon: '📈', label: '监控' },
    { to: '/settings', icon: '⚙️', label: '设置' },
  ];

  const isActive = (path: string) => {
    return location.pathname.startsWith(path);
  };

  const handleNavClick = () => {
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
          fontSize: 'var(--fs-title)',
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
        ))}
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