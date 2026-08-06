// PmoNumberBadge 测试 — C4 修复：PmoNumberLink 跳转目标为路由表中已存在的 /project/:projectId
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PmoNumberBadge, PmoNumberLink } from '../PmoNumberBadge';

describe('PmoNumberBadge', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('渲染 PMO 号（去重 PM- 前缀）', () => {
    render(<PmoNumberBadge pmoNumber="PM-001" />);
    expect(screen.getByText('001')).toBeInTheDocument();
  });

  it('PmoNumberLink 点击跳转 /project/:projectId', () => {
    const location = { href: '' };
    vi.stubGlobal('location', location);

    render(<PmoNumberLink pmoNumber="PM-001" projectId="p1" />);
    fireEvent.click(screen.getByText('001'));

    expect(location.href).toBe('/project/p1');
  });

  it('PmoNumberLink 无 projectId 时不跳转', () => {
    const location = { href: '' };
    vi.stubGlobal('location', location);

    render(<PmoNumberLink pmoNumber="PM-001" />);
    fireEvent.click(screen.getByText('001'));

    expect(location.href).toBe('');
  });
});
