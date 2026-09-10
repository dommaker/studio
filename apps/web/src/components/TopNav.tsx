// TopNav.tsx - 顶部导航栏组件（L1 核心功能）
// MR-009: 移动端适配 - 添加汉堡菜单
import { Link } from 'react-router-dom';
import { ThemeToggleButton } from '../contexts/ThemeContext';
import { MoreDropdown } from './MoreDropdown';
import { NotificationBell } from './NotificationBell';
import { useWebSocketContext } from '../api/websocketHooks';
import { IconZap } from './ui/icons';
import '../styles/theme.css';

interface TopNavProps {
  onMenuClick?: () => void;  // MR-009: 汉堡菜单回调
  onOpenSearch?: () => void; // 批次 D-2 项 8：「搜索 ⌘K」入口（MoreDropdown 透传）
}

export function TopNav({ onMenuClick, onOpenSearch }: TopNavProps) {
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
      >
        <span className="hamburger-line" />
        <span className="hamburger-line" />
        <span className="hamburger-line" />
      </button>

      {/* Logo（批次 D-1.2：⚡ emoji → IconZap SVG；品牌双色调：Agent 正文色 / Studio accent） */}
      <Link
        to="/"
        className="brand-link text-xl flex items-center gap-2"
      >
        <span className="u-accent flex items-center"><IconZap size={20} /></span>
        <span className="tracking-tight hide-mobile">
          <span className="u-text font-medium">Agent</span>{' '}<span className="u-accent font-extrabold">Studio</span>
        </span>
      </Link>

      {/* 工具栏 */}
      <div className="ml-auto flex items-center gap-4">
        {/* SSE 连接状态（批次 D-1.2：chip 化） */}
        <div className="conn-chip hide-mobile">
          <span className={`status-dot ${connected ? 'status-online' : 'status-offline'}`} />
          <span>{connected ? '已连接' : '未连接'}</span>
        </div>

        {/* 通知中心 (B2-003) */}
        <NotificationBell />

        {/* 主题切换 */}
        <ThemeToggleButton />

        {/* L4 高级功能下拉 */}
        <MoreDropdown onOpenSearch={onOpenSearch} />
      </div>
    </header>
  );
}