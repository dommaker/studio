// MoreDropdown.tsx - "更多"下拉菜单组件（L4 高级功能）
// 左侧 sidebar「更多」收纳项已并入本下拉（知识库/阅览室/监控 + 审计日志/设置；PMO 为 sidebar 四主项之一，不重复收纳）
import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
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

export function MoreDropdown() {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

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
        onClick={() => setIsOpen(!isOpen)}
        className="btn btn-ghost flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors u-text-2"
      >
        <span>🗂</span>
        <span className="hidden sm:inline">更多</span>
        <span className="text-xs">{isOpen ? '▼' : '▶'}</span>
      </button>

      {isOpen && (
        <div
          className="absolute right-0 top-full mt-1 w-52 rounded-lg shadow-xl py-2 z-50"
          style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-default)',
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