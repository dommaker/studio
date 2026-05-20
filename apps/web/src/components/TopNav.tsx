// TopNav.tsx - 顶部导航栏组件（L1 核心功能）
// MR-009: 移动端适配 - 添加汉堡菜单
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ThemeToggleButton } from '../contexts/ThemeContext';
import { LanguageSwitcher } from './LanguageSwitcher';
import { MoreDropdown } from './MoreDropdown';
import { NotificationBell } from './NotificationBell';
import '../styles/theme.css';

interface TopNavProps {
  wsStatus?: 'connected' | 'disconnected';
  onMenuClick?: () => void;  // MR-009: 汉堡菜单回调
}

export function TopNav({ wsStatus = 'disconnected', onMenuClick }: TopNavProps) {
  const { t } = useTranslation();
  const location = useLocation();

  return (
    <header className="nav-header flex items-center px-6 shrink-0 sticky top-0 z-40">
      {/* MR-009: 汉堡菜单按钮（移动端） */}
      <button 
        className="hamburger-btn hide-desktop"
        onClick={onMenuClick}
        aria-label="打开菜单"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '5px',
          padding: '8px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          marginRight: '1rem',
        }}
      >
        <span style={{ width: '20px', height: '2px', background: 'var(--text-primary)' }}></span>
        <span style={{ width: '20px', height: '2px', background: 'var(--text-primary)' }}></span>
        <span style={{ width: '20px', height: '2px', background: 'var(--text-primary)' }}></span>
      </button>
      
      {/* Logo */}
      <Link 
        to="/" 
        className="text-xl font-bold flex items-center gap-2 transition-opacity hover:opacity-80"
        style={{ color: 'var(--accent-primary)' }}
      >
        <span className="text-2xl">⚡</span>
        <span className="tracking-tight hide-mobile">
          Agent <span className="font-extrabold">Studio</span>
        </span>
      </Link>

      {/* L1 核心导航（桌面端） */}
      <nav className="ml-8 flex items-center gap-1 hide-mobile">
        <Link
          to="/workflows"
          className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
            location.pathname.startsWith('/workflows') ? 'nav-tab-active' : 'nav-tab'
          }`}
        >
          🔄 {t('nav.workflows', '工作流')}
        </Link>
        <Link
          to="/roles"
          className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
            location.pathname.startsWith('/roles') ? 'nav-tab-active' : 'nav-tab'
          }`}
        >
          👥 {t('nav.roles', '角色')}
        </Link>
      </nav>

      {/* 工具栏 */}
      <div className="ml-auto flex items-center gap-4">
        <div className="hide-mobile">
          <LanguageSwitcher />
        </div>

        {/* WebSocket 状态 */}
        <div className="flex items-center gap-2 text-sm hide-mobile">
          <span className={`status-dot ${wsStatus === 'connected' ? 'status-online' : 'status-offline'}`} />
          <span style={{ color: 'var(--text-secondary)' }}>
            {wsStatus === 'connected' ? t('connection.connected', '已连接') : t('connection.disconnected', '未连接')}
          </span>
        </div>

        {/* 通知中心 (B2-003) */}
        <NotificationBell />

        {/* 主题切换 */}
        <ThemeToggleButton />

        {/* L4 高级功能下拉 */}
        <MoreDropdown />
      </div>
    </header>
  );
}