// AuthorAvatar - 频道消息作者头像：人类=品牌色+首字/头像图，Agent=名字 hash 稳定色+首字
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const { mockUseAuthStore } = vi.hoisted(() => ({ mockUseAuthStore: vi.fn() }));
vi.mock('../../../stores/authStore', () => ({
  useAuthStore: (selector: (s: { user: unknown }) => unknown) => selector({ user: mockUseAuthStore() }),
}));

import { AuthorAvatar } from '../AuthorAvatar';

describe('AuthorAvatar', () => {
  beforeEach(() => {
    mockUseAuthStore.mockReset();
    mockUseAuthStore.mockReturnValue(null);
  });

  it('人类用户无 avatar -> 品牌色背景 + 用户名首字（大写）', () => {
    mockUseAuthStore.mockReturnValue({ name: '张三', email: 'z@x.com', avatar: undefined });
    const { container } = render(<AuthorAvatar isHuman={true} />);
    const el = container.querySelector('.mc-avatar');
    expect(el).toBeTruthy();
    expect(el!.classList.contains('mc-avatar-human')).toBe(true);
    expect(el!.textContent).toBe('张'); // Array.from 首字
    expect(el!.tagName).toBe('SPAN');
  });

  it('人类用户名缺失 -> 回退 email 首字', () => {
    mockUseAuthStore.mockReturnValue({ email: 'dev@x.com', avatar: undefined });
    const { container } = render(<AuthorAvatar isHuman={true} />);
    expect(container.querySelector('.mc-avatar')!.textContent).toBe('D'); // email 首字大写
  });

  it('人类用户无 name/email -> 回退 "You" 首字', () => {
    mockUseAuthStore.mockReturnValue({});
    const { container } = render(<AuthorAvatar isHuman={true} />);
    expect(container.querySelector('.mc-avatar')!.textContent).toBe('Y');
  });

  it('人类用户有 avatar -> 渲染 img（带 alt/title）', () => {
    mockUseAuthStore.mockReturnValue({ name: '李四', avatar: 'https://x.com/a.png' });
    const { container } = render(<AuthorAvatar isHuman={true} />);
    const img = container.querySelector('img.mc-avatar') as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(img.src).toBe('https://x.com/a.png');
    expect(img.alt).toBe('李四');
    expect(img.title).toBe('李四');
  });

  it('Agent -> hash 稳定色背景 + agentName 首字（非人类样式）', () => {
    const { container, rerender } = render(<AuthorAvatar isHuman={false} agentName="Pat" />);
    const el = container.querySelector('.mc-avatar') as HTMLElement;
    expect(el).toBeTruthy();
    expect(el.classList.contains('mc-avatar-human')).toBe(false);
    expect(el.textContent).toBe('P');
    const bg1 = el.style.background;

    // 同名 -> 同色（稳定 hue）
    rerender(<AuthorAvatar isHuman={false} agentName="Pat" />);
    const el2 = container.querySelector('.mc-avatar') as HTMLElement;
    expect(el2.style.background).toBe(bg1);

    // 换名 -> 换色（不同 hash）
    rerender(<AuthorAvatar isHuman={false} agentName="Hank" />);
    const el3 = container.querySelector('.mc-avatar') as HTMLElement;
    expect(el3.textContent).toBe('H');
    expect(el3.style.background).not.toBe(bg1);
  });

  it('Agent 无 agentName -> 回退 "Agent" 首字 A', () => {
    const { container } = render(<AuthorAvatar isHuman={false} />);
    expect(container.querySelector('.mc-avatar')!.textContent).toBe('A');
  });

  it('CJK 与 emoji 代理对：取 Array.from 首码点（不崩）', () => {
    mockUseAuthStore.mockReturnValue({ name: '🎯目标', avatar: undefined });
    const { container } = render(<AuthorAvatar isHuman={true} />);
    expect(container.querySelector('.mc-avatar')!.textContent).toBe('🎯');
  });
});
