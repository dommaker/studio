// PmoNumberBadge 测试 — 工单 36-F2：PmoNumberLink 改 SPA 导航（useNavigate，替代整页刷新）
// #432 C1：徽标直接显示原始 pmoNumber，不再拼 PM- 前缀（编号本身已含 PMO-）
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }));
vi.mock('react-router-dom', () => ({ useNavigate: () => mockNavigate }));

import { PmoNumberBadge, PmoNumberLink } from '../PmoNumberBadge';

describe('PmoNumberBadge', () => {
  it('原样渲染编号，不加额外前缀（#432 C1：无「PM- PMO-1」双前缀）', () => {
    render(<PmoNumberBadge pmoNumber="PMO-1" />);
    const badge = screen.getByText('PMO-1');
    expect(badge.textContent).toBe('PMO-1');
  });

  it('PmoNumberLink 点击 SPA 导航至 /project/:projectId', () => {
    render(<PmoNumberLink pmoNumber="PMO-1" projectId="p1" />);
    fireEvent.click(screen.getByText('PMO-1'));

    expect(mockNavigate).toHaveBeenCalledWith('/project/p1');
  });

  it('PmoNumberLink 无 projectId 时不导航', () => {
    mockNavigate.mockClear();
    render(<PmoNumberLink pmoNumber="PMO-1" />);
    fireEvent.click(screen.getByText('PMO-1'));

    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
