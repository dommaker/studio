// Contract test: EventSearchPanel — #180 事件检索面板（#60 决策 Q3a）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

const { mockSearch } = vi.hoisted(() => ({ mockSearch: vi.fn() }));
vi.mock('../../../api/events', () => ({
  eventsApi: { search: mockSearch },
}));

import { EventSearchPanel } from '../EventSearchPanel';

describe('EventSearchPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearch.mockResolvedValue({ data: { events: [], total: 0, nextCursor: null } });
  });

  it('渲染检索表单：级别/类型/关键词/截止时间/查询', () => {
    render(<EventSearchPanel />);
    expect(screen.getByLabelText('级别')).toBeDefined();
    expect(screen.getByPlaceholderText('类型（可选），如 workunit:failed')).toBeDefined();
    expect(screen.getByPlaceholderText('关键词（可选）')).toBeDefined();
    expect(screen.getByLabelText('截止时间（可选）')).toBeDefined();
    expect(screen.getByText('查询')).toBeDefined();
  });

  it('空结果显示「没有匹配的事件」', async () => {
    render(<EventSearchPanel />);
    fireEvent.click(screen.getByText('查询'));
    expect(await screen.findByText('没有匹配的事件')).toBeDefined();
  });

  it('查询透传 level/keyword 参数；结果渲染级别徽标与 payload 摘要', async () => {
    mockSearch.mockResolvedValue({
      data: {
        events: [
          { type: 'workunit:failed', source: 'agent-loop', level: 'critical', payload: '{"blockReason":"boom"}', createdAt: '2026-08-15T10:00:00.000Z' },
        ],
        total: 1,
        nextCursor: null,
      },
    });
    render(<EventSearchPanel />);
    fireEvent.click(screen.getByLabelText('级别'));
    fireEvent.click(await screen.findByRole('option', { name: '仅警告和严重' }));
    fireEvent.change(screen.getByPlaceholderText('关键词（可选）'), { target: { value: 'boom' } });
    fireEvent.click(screen.getByText('查询'));

    await waitFor(() => {
      expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ level: 'warning', keyword: 'boom', limit: 50 }));
    });
    expect(await screen.findByText('workunit:failed')).toBeDefined();
    expect(screen.getByText('严重')).toBeDefined();
    expect(screen.getByText(/boom/)).toBeDefined();
  });

  it('回车触发查询', async () => {
    render(<EventSearchPanel />);
    fireEvent.keyDown(screen.getByPlaceholderText('关键词（可选）'), { key: 'Enter' });
    await waitFor(() => expect(mockSearch).toHaveBeenCalled());
  });

  it('查询失败显示错误提示', async () => {
    mockSearch.mockRejectedValue(new Error('boom'));
    render(<EventSearchPanel />);
    fireEvent.click(screen.getByText('查询'));
    expect(await screen.findByText(/查询失败/)).toBeDefined();
  });
});

describe('EventSearchPanel — initialFilters（E4 告警下钻预填）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearch.mockResolvedValue({ data: { events: [], total: 0, nextCursor: null } });
  });

  it('预填 type/keyword/level 到表单，挂载即自动检索一次', async () => {
    render(<EventSearchPanel initialFilters={{ type: 'monitor:alert', keyword: '心跳过期', level: 'warning' }} />);

    await waitFor(() => {
      expect(mockSearch).toHaveBeenCalledTimes(1);
      expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({
        type: 'monitor:alert', keyword: '心跳过期', level: 'warning', limit: 50,
      }));
    });
    expect((screen.getByPlaceholderText('类型（可选），如 workunit:failed') as HTMLInputElement).value).toBe('monitor:alert');
    expect((screen.getByPlaceholderText('关键词（可选）') as HTMLInputElement).value).toBe('心跳过期');
  });

  it('无 initialFilters 时不自动检索（手动点查询才发请求）', () => {
    render(<EventSearchPanel />);
    expect(mockSearch).not.toHaveBeenCalled();
  });
});
