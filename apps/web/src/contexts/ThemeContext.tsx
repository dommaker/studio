// Theme Context - 主题切换（组件门面；Theme 类型 / ThemeContext / useTheme 见 ./useTheme）
import { useEffect, useState, type ReactNode } from 'react';
import { ThemeContext, useTheme, type Theme } from './useTheme';

export type { Theme } from './useTheme';
export { ThemeContext, useTheme } from './useTheme';

const THEME_STORAGE_KEY = 'agent-studio-theme';

/**
 * 获取系统主题偏好
 */
function getSystemTheme(): 'dark' | 'light' {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

interface ThemeProviderProps {
  children: ReactNode;
  defaultTheme?: Theme;
}

export function ThemeProvider({ children, defaultTheme = 'dark' }: ThemeProviderProps) {
  const [theme, setThemeState] = useState<Theme>(() => {
    // 从 localStorage 读取
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem(THEME_STORAGE_KEY) as Theme | null;
      if (stored && ['dark', 'light', 'system'].includes(stored)) {
        return stored;
      }
    }
    return defaultTheme;
  });

  // 系统偏好为外部状态：独立 state + media listener 订阅更新；
  // resolvedTheme 改为渲染期纯派生，不再是独立 state（替代原 effect 内同步 setResolvedTheme）
  const [systemDark, setSystemDark] = useState(() => getSystemTheme() === 'dark');
  const resolvedTheme: 'dark' | 'light' = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;

  // 应用主题到 DOM
  useEffect(() => {
    // 设置 data-theme 属性
    document.documentElement.setAttribute('data-theme', resolvedTheme);

    // 保存到 localStorage
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme, resolvedTheme]);

  // 监听系统主题变化
  useEffect(() => {
    if (theme !== 'system') return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

    const handleChange = () => {
      setSystemDark(mediaQuery.matches);
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [theme]);

  const setTheme = (newTheme: Theme) => {
    setThemeState(newTheme);
  };

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

/**
 * 主题切换按钮组件
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  const themes: { value: Theme; label: string; icon: string }[] = [
    { value: 'dark', label: '深色', icon: '🌙' },
    { value: 'light', label: '浅色', icon: '☀️' },
    { value: 'system', label: '跟随系统', icon: '💻' },
  ];

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
    }}>
      {themes.map((t) => (
        <button
          key={t.value}
          onClick={() => setTheme(t.value)}
          style={{
            background: theme === t.value ? 'var(--accent-primary)' : 'var(--bg-tertiary)',
            border: '1px solid var(--border-default)',
            borderRadius: '8px',
            padding: '8px 12px',
            fontSize: 'var(--fs-base)',
            color: theme === t.value ? 'var(--bg-primary)' : 'var(--text-primary)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            transition: 'all 0.15s ease',
          }}
        >
          <span>{t.icon}</span>
          <span>{t.label}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * 简洁的主题切换按钮
 */
export function ThemeToggleButton() {
  const { resolvedTheme, setTheme } = useTheme();

  const toggleTheme = () => {
    setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
  };

  return (
    <button
      onClick={toggleTheme}
      style={{
        background: 'var(--bg-tertiary)',
        border: '1px solid var(--border-default)',
        borderRadius: '8px',
        padding: '8px 12px',
        fontSize: 'var(--fs-title)',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'all 0.15s ease',
      }}
      title={resolvedTheme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
    >
      {resolvedTheme === 'dark' ? '☀️' : '🌙'}
    </button>
  );
}