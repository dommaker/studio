// TopNav.tsx - 顶部导航栏组件（L1 核心功能）
// MR-009: 移动端适配 - 添加汉堡菜单
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ThemeToggleButton } from '../contexts/ThemeContext';
import { LanguageSwitcher } from './LanguageSwitcher';
import { MoreDropdown } from './MoreDropdown';
import { NotificationBell } from './NotificationBell';
import { useWebSocketContext } from '../api/websocket';
import '../styles/theme.css';

interface TopNavProps {
  onMenuClick?: () => void;  // MR-009: 汉堡菜单回调
}

export function TopNav({ onMenuClick }: TopNavProps) {
  const { t } = useTranslation();
  // 连接状态读取应用根部唯一的 SSE 连接（WebSocketProvider）
  const { status } = useWebSocketContext();
  const connected = status === 'connected';

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

      {/* 工具栏 */}
      <div className="ml-auto flex items-center gap-4">
        <div className="hide-mobile">
          <LanguageSwitcher />
        </div>

        {/* SSE 连接状态 */}
        <div className="flex items-center gap-2 text-sm hide-mobile">
          <span className={`status-dot ${connected ? 'status-online' : 'status-offline'}`} />
          <span style={{ color: 'var(--text-secondary)' }}>
            {connected ? t('connection.connected', '已连接') : t('connection.disconnected', '未连接')}
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