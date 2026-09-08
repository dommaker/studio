// AgentAvatar（#440 Phase 4）— identicon 式确定性头像：SVG 5x5 镜像网格，色源 = 现有 --chart-1..9 调色板
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { AgentAvatar } from '../AgentAvatar';

describe('AgentAvatar', () => {
  it('渲染 SVG 网格头像，title/aria-label = agent 名', () => {
    const { container } = render(<AgentAvatar name="dev-agent" />);
    const el = container.querySelector('.mc-avatar-ident') as HTMLElement;
    expect(el).toBeTruthy();
    expect(el.getAttribute('title')).toBe('dev-agent');
    const svg = el.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg!.getAttribute('fill')).toMatch(/^var\(--chart-[1-9]\)$/);
    expect(svg!.querySelectorAll('rect').length).toBeGreaterThan(0);
  });

  it('确定性：同名两次渲染 SVG 完全一致；不同名不同', () => {
    const { container, rerender } = render(<AgentAvatar name="pm" />);
    const html1 = container.querySelector('.mc-avatar-ident')!.innerHTML;
    rerender(<AgentAvatar name="pm" />);
    expect(container.querySelector('.mc-avatar-ident')!.innerHTML).toBe(html1);
    rerender(<AgentAvatar name="reviewer" />);
    expect(container.querySelector('.mc-avatar-ident')!.innerHTML).not.toBe(html1);
  });

  it('网格镜像对称：每行 col0=col4、col1=col3', () => {
    const { container } = render(<AgentAvatar name="dev-agent" size={20} />);
    const rects = [...container.querySelectorAll('rect')].map(r => ({
      col: Number(r.getAttribute('x')) / 4,
      row: Number(r.getAttribute('y')) / 4,
    }));
    const filled = new Set(rects.map(r => `${r.row}:${r.col}`));
    for (const { col, row } of rects) {
      if (col <= 2) {
        expect(filled.has(`${row}:${4 - col}`), `row ${row} col ${col} 缺镜像格`).toBe(true);
      }
    }
  });

  it('自定义 size（profile 页大图场景）', () => {
    const { container } = render(<AgentAvatar name="ops" size={30} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('width')).toBe('30');
    expect(svg.getAttribute('viewBox')).toBe('0 0 30 30');
  });
});
