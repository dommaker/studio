// NotFoundPage 测试 — C4 修复：404 兜底路由页面
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { NotFoundPage } from '../NotFoundPage';

describe('NotFoundPage', () => {
  it('渲染 404 提示与返回首页链接', () => {
    render(
      <MemoryRouter>
        <NotFoundPage />
      </MemoryRouter>,
    );
    expect(screen.getByText('404')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '返回首页' })).toHaveAttribute('href', '/');
  });
});
