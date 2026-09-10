// Theme Context - 主题切换（组件门面；Theme 类型 / ThemeContext / useTheme 见 ./useTheme）
import { useEffect, useState, type ReactNode } from 'react';
import { ThemeContext, useTheme, type Theme } from './useTheme';
import { IconMoon, IconSun } from '../components/ui/icons';

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
 * 顶栏主题切换按钮（dark/light 互切；三选设置见 components/settings/ThemeSettings）
 * 批次 D-0：去 emoji 改 SVG（ui/icons）、内联样式类化（.icon-btn）、圆角归按钮档
 */
export function ThemeToggleButton() {
  const { resolvedTheme, setTheme } = useTheme();

  const toggleTheme = () => {
    setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
  };

  return (
    <button
      onClick={toggleTheme}
      className="icon-btn"
      title={resolvedTheme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
      aria-label={resolvedTheme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
    >
      {resolvedTheme === 'dark' ? <IconSun size={16} /> : <IconMoon size={16} />}
    </button>
  );
}