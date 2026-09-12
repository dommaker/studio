// #476：PMO 统一标识 chip——频道内三处呈现（顶栏/右栏/消息 footer）复用同一视觉语言。
// 契约：ui/icons PMO 图标（stroke SVG）+ 文本同一 chip；中性配色（#472：身份不占状态色语义）；零 emoji（#474 图标策略）。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PmoChip } from '../PmoChip';

describe('PmoChip（#476 PMO 统一标识）', () => {
  it('渲染 .pmo-chip + PMO 图标（stroke svg）+ 文本', () => {
    const { container } = render(<PmoChip label="PMO · 商城重构" onClick={vi.fn()} />);
    const chip = container.querySelector('.pmo-chip');
    expect(chip).toBeTruthy();
    expect(chip!.querySelector('svg')).toBeTruthy();
    expect(screen.getByText('PMO · 商城重构')).toBeTruthy();
  });

  it('点击触发 onClick；aria-label / title 透传', () => {
    const onClick = vi.fn();
    render(<PmoChip label="PMO" onClick={onClick} ariaLabel="打开项目详情" title="打开项目详情" />);
    const chip = screen.getByRole('button', { name: '打开项目详情' });
    fireEvent.click(chip);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(chip.title).toBe('打开项目详情');
  });

  it('中性配色：不挂状态色修饰类（success/warning 是状态语义，不是身份语义）', () => {
    const { container } = render(<PmoChip label="PMO" onClick={vi.fn()} />);
    const cls = container.querySelector('.pmo-chip')!.className;
    expect(cls).not.toContain('success');
    expect(cls).not.toContain('warning');
    expect(cls).not.toContain('mc-wu-link--pmo');
  });

  it('零 emoji/装饰符号：可见文本即传入 label', () => {
    render(<PmoChip label="PMO-7 · 项目X" onClick={vi.fn()} />);
    expect(screen.getByRole('button').textContent).toBe('PMO-7 · 项目X');
  });

  it('className 透传（站点布局钩子，如顶栏 mc-pmo-chip / 右栏 mc-act-pmo-badge）', () => {
    const { container } = render(<PmoChip label="PMO" onClick={vi.fn()} className="mc-pmo-chip" />);
    expect(container.querySelector('.pmo-chip')!.className).toContain('mc-pmo-chip');
  });
});
