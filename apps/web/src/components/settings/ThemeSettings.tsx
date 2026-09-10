// 主题设置 section（从 pages/Settings.tsx 抽取，工单 35-E3）
// 批次 D-0：去 emoji 改 SVG（ui/icons，#474 策略）+ 内联样式类化（.theme-option）
import { useTheme, type Theme } from '../../contexts/useTheme';
import { IconMonitor, IconMoon, IconSun, type IconProps } from '../ui/icons';
import type { ComponentType } from 'react';

export function ThemeSettings() {
  const { theme, setTheme } = useTheme();
  const themes: { value: Theme; label: string; Icon: ComponentType<IconProps>; desc: string }[] = [
    { value: 'dark', label: '深色', Icon: IconMoon, desc: '适合夜间工作，科幻极简风格' },
    { value: 'light', label: '浅色', Icon: IconSun, desc: '适合日间工作，明亮清爽' },
    { value: 'system', label: '跟随系统', Icon: IconMonitor, desc: '自动跟随系统主题设置' },
  ];
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      {themes.map((t) => (
        <button key={t.value} onClick={() => setTheme(t.value)}
          className={`theme-option${theme === t.value ? ' theme-option-active' : ''}`}
          aria-pressed={theme === t.value}>
          <div className="theme-option-icon"><t.Icon size={22} /></div>
          <div className="font-medium mb-1 u-text">{t.label}</div>
          <div className="text-xs u-text-3">{t.desc}</div>
        </button>
      ))}
    </div>
  );
}
