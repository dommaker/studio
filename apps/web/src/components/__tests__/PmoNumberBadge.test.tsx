// PmoNumberBadge 测试 — 工单 36-F2：PmoNumberLink 改 SPA 导航（useNavigate，替代整页刷新）
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }));
vi.mock('react-router-dom', () => ({ useNavigate: () => mockNavigate }));

import { PmoNumberBadge, PmoNumberLink } from '../PmoNumberBadge';

describe('PmoNumberBadge', () => {
  it('渲染 PMO 号（去重 PM- 前缀）', () => {
    render(<PmoNumberBadge pmoNumber="PM-001" />);
    expect(screen.getByText('001')).toBeInTheDocument();
  });

  it('PmoNumberLink 点击 SPA 导航至 /project/:projectId', () => {
    render(<PmoNumberLink pmoNumber="PM-001" projectId="p1" />);
    fireEvent.click(screen.getByText('001'));

    expect(mockNavigate).toHaveBeenCalledWith('/project/p1');
  });

  it('PmoNumberLink 无 projectId 时不导航', () => {
    mockNavigate.mockClear();
    render(<PmoNumberLink pmoNumber="PM-001" />);
    fireEvent.click(screen.getByText('001'));

    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
