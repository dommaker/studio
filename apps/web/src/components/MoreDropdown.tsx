// MoreDropdown.tsx - "更多"下拉菜单组件（L4 高级功能）
import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import '../styles/theme.css';

interface DropdownItem {
  to: string;
  icon: string;
  label: string;
  i18nKey?: string;
}

const MORE_ITEMS: DropdownItem[] = [
  { to: '/audit-logs', icon: '🔍', label: '审计日志', i18nKey: 'nav.auditLogs' },
  { to: '/pmo', icon: '📊', label: 'PMO', i18nKey: 'nav.pmo' },
];

const CONFIG_ITEMS: DropdownItem[] = [
  { to: '/tools', icon: '🔩', label: '工具管理', i18nKey: 'nav.tools' },
  { to: '/settings', icon: '⚙️', label: '设置', i18nKey: 'nav.settings' },
];

export function MoreDropdown() {
  const { t } = useTranslation();
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
      className="block px-4 py-2 text-sm transition-colors flex items-center gap-2"
      style={{ color: 'var(--text-primary)' }}
      onClick={() => setIsOpen(false)}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <span>{item.icon}</span>
      <span>{item.i18nKey ? t(item.i18nKey, item.label) : item.label}</span>
    </Link>
  );

  return (
    <div ref={dropdownRef} className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="btn btn-ghost flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors"
        style={{ color: 'var(--text-secondary)' }}
      >
        <span>📈</span>
        <span className="hidden sm:inline">{t('nav.more', '更多')}</span>
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
            <span className="text-xs font-medium px-2" style={{ color: 'var(--text-tertiary)' }}>
              {t('nav.advanced', '高级功能')}
            </span>
          </div>
          {MORE_ITEMS.map(renderItem)}

          <div className="my-1 mx-2" style={{ borderTop: '1px solid var(--border-subtle)' }} />

          {/* 配置功能 */}
          <div className="px-2 pb-1">
            <span className="text-xs font-medium px-2" style={{ color: 'var(--text-tertiary)' }}>
              {t('nav.config', '配置')}
            </span>
          </div>
          {CONFIG_ITEMS.map(renderItem)}
        </div>
      )}
    </div>
  );
}