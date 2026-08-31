// #393 全站详情页统一返回按钮：有站内历史 navigate(-1)，直开/书签回落默认列表页
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

import { BackButton } from '../BackButton';

const renderBtn = (fallback = '/workunits') =>
  render(
    <MemoryRouter>
      <BackButton fallback={fallback} />
    </MemoryRouter>,
  );

describe('BackButton — §4.4 详情页统一返回', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    window.history.replaceState(null, '');
  });

  it('渲染「← 返回」', () => {
    renderBtn();
    expect(screen.getByRole('button', { name: '← 返回' })).toBeTruthy();
  });

  it('有站内历史（history.state.idx > 0）→ navigate(-1)', () => {
    window.history.replaceState({ idx: 3 }, '');
    renderBtn();
    fireEvent.click(screen.getByRole('button', { name: '← 返回' }));
    expect(mockNavigate).toHaveBeenCalledWith(-1);
  });

  it('直开/书签（idx = 0）→ 回落默认列表页', () => {
    window.history.replaceState({ idx: 0 }, '');
    renderBtn('/pmo');
    fireEvent.click(screen.getByRole('button', { name: '← 返回' }));
    expect(mockNavigate).toHaveBeenCalledWith('/pmo');
  });

  it('history.state 无 idx 字段 → 回落默认列表页', () => {
    window.history.replaceState(null, '');
    renderBtn('/library');
    fireEvent.click(screen.getByRole('button', { name: '← 返回' }));
    expect(mockNavigate).toHaveBeenCalledWith('/library');
  });
});
