// AuthorAvatar - 频道消息作者头像：人类=品牌色+首字/头像图，Agent=名字 hash 稳定色+首字
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

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

  it('Agent -> identicon 图形头像（#440：同名恒同图，不同名可区分；不再是色块+首字）', () => {
    const { container, rerender } = render(<AuthorAvatar isHuman={false} agentName="Pat" />);
    const el = container.querySelector('.mc-avatar-ident') as HTMLElement;
    expect(el).toBeTruthy();
    expect(el.classList.contains('mc-avatar-human')).toBe(false);
    expect(el.getAttribute('title')).toBe('Pat');
    const html1 = el.innerHTML;

    // 同名 -> 同图（确定性 hash）
    rerender(<AuthorAvatar isHuman={false} agentName="Pat" />);
    expect((container.querySelector('.mc-avatar-ident') as HTMLElement).innerHTML).toBe(html1);

    // 换名 -> 换图（不同 hash）
    rerender(<AuthorAvatar isHuman={false} agentName="Hank" />);
    const el3 = container.querySelector('.mc-avatar-ident') as HTMLElement;
    expect(el3.getAttribute('title')).toBe('Hank');
    expect(el3.innerHTML).not.toBe(html1);
  });

  it('Agent 无 agentName -> 回退 "Agent"', () => {
    const { container } = render(<AuthorAvatar isHuman={false} />);
    expect(container.querySelector('.mc-avatar-ident')!.getAttribute('title')).toBe('Agent');
  });

  it('CJK 与 emoji 代理对：取 Array.from 首码点（不崩）', () => {
    mockUseAuthStore.mockReturnValue({ name: '🎯目标', avatar: undefined });
    const { container } = render(<AuthorAvatar isHuman={true} />);
    expect(container.querySelector('.mc-avatar')!.textContent).toBe('🎯');
  });
});
