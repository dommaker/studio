// 主题设置 section（从 pages/Settings.tsx 抽取，工单 35-E3）
import { useTranslation } from 'react-i18next';
import { useTheme, type Theme } from '../../contexts/ThemeContext';

export function ThemeSettings() {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  const themes: { value: Theme; label: string; icon: string; desc: string }[] = [
    { value: 'dark', label: t('theme.dark'), icon: '🌙', desc: '适合夜间工作，科幻极简风格' },
    { value: 'light', label: t('theme.light'), icon: '☀️', desc: '适合日间工作，明亮清爽' },
    { value: 'system', label: t('theme.system'), icon: '💻', desc: '自动跟随系统主题设置' },
  ];
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      {themes.map((t) => (
        <button key={t.value} onClick={() => setTheme(t.value)}
          className="p-4 rounded-xl text-left transition-all"
          style={{
            background: theme === t.value ? 'var(--bg-elevated)' : 'var(--bg-tertiary)',
            border: theme === t.value ? '2px solid var(--accent-primary)' : '2px solid var(--border-subtle)',
            boxShadow: theme === t.value ? 'var(--shadow-glow)' : 'none',
          }}>
          <div className="text-2xl mb-2">{t.icon}</div>
          <div className="font-medium mb-1 u-text">{t.label}</div>
          <div className="text-xs u-text-3">{t.desc}</div>
        </button>
      ))}
    </div>
  );
}
