// 批次 D-0：主题切换控件规范化——去 emoji 改 SVG、内联类化、aria 语义
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThemeProvider, ThemeToggleButton } from '../ThemeContext';
import { ThemeSettings } from '../../components/settings/ThemeSettings';
import { IconSun, IconMoon, IconMonitor } from '../../components/ui/icons';

// ThemeProvider 初始主题读 localStorage（agent-studio-theme），用例间须清理防串扰
beforeEach(() => {
  localStorage.clear();
});

describe('IconSun / IconMoon / IconMonitor（批次 D-0 新增）', () => {
  it('渲染 24×24 stroke SVG 且 aria-hidden', () => {
    const { container } = render(
      <>
        <IconSun />
        <IconMoon />
        <IconMonitor />
      </>,
    );
    const svgs = container.querySelectorAll('svg');
    expect(svgs).toHaveLength(3);
    svgs.forEach((svg) => {
      expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
      expect(svg.getAttribute('aria-hidden')).toBe('true');
    });
  });
});

describe('ThemeToggleButton — 顶栏 dark/light 互切', () => {
  it('深色下提示切浅色，点击后 setTheme 生效（提示变切深色）', () => {
    render(
      <ThemeProvider defaultTheme="dark">
        <ThemeToggleButton />
      </ThemeProvider>,
    );
    const btn = screen.getByRole('button', { name: '切换到浅色主题' });
    expect(btn.className).toContain('icon-btn');
    expect(btn.querySelector('svg')).toBeTruthy();
    fireEvent.click(btn);
    expect(screen.getByRole('button', { name: '切换到深色主题' })).toBeTruthy();
  });
});

describe('ThemeSettings — 三选主题卡', () => {
  it('三张卡带 SVG 图标与 aria-pressed，点击切换选中态', () => {
    render(
      <ThemeProvider defaultTheme="dark">
        <ThemeSettings />
      </ThemeProvider>,
    );
    const dark = screen.getByRole('button', { name: /深色/ });
    const light = screen.getByRole('button', { name: /浅色/ });
    expect(dark.getAttribute('aria-pressed')).toBe('true');
    expect(light.getAttribute('aria-pressed')).toBe('false');
    expect(dark.querySelector('svg')).toBeTruthy();
    fireEvent.click(light);
    expect(screen.getByRole('button', { name: /浅色/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: /深色/ }).getAttribute('aria-pressed')).toBe('false');
  });
});
