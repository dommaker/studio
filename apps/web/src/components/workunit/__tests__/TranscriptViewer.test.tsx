// TranscriptViewer — #174: WU 认证只读 transcript 查看器（#60 C5）
// 渲染契约：默认折叠不请求 → 展开拉第一页 → entries 渲染 → 「加载更多」按 offset 翻页 → 到底隐藏
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual, default: actual };
});

const { mockTranscriptGet } = vi.hoisted(() => ({
  mockTranscriptGet: vi.fn(),
}));

vi.mock('../../../api/transcript', () => ({
  transcriptsApi: { get: mockTranscriptGet },
}));

import { TranscriptViewer } from '../TranscriptViewer';

const entry = (step: number) => ({
  workUnitId: 'wu-1',
  step,
  action: 'progress',
  rawOutput: `step-${step} raw output`,
  createdAt: '2026-08-15T10:00:00.000Z',
});

describe('TranscriptViewer (#174)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTranscriptGet.mockResolvedValue({
      data: { workUnitId: 'wu-1', total: 2, offset: 0, limit: 20, entries: [entry(1), entry(2)] },
    });
  });

  it('默认折叠：不渲染条目、不调 API', () => {
    render(<TranscriptViewer workUnitId="wu-1" />);
    expect(mockTranscriptGet).not.toHaveBeenCalled();
    expect(screen.queryByText(/step-1 raw output/)).toBeNull();
  });

  it('点击展开后调 API（默认 offset=0/limit=20）并渲染 entry', async () => {
    render(<TranscriptViewer workUnitId="wu-1" />);
    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(screen.getByText(/step-1 raw output/)).toBeTruthy());
    expect(mockTranscriptGet).toHaveBeenCalledWith('wu-1', { offset: 0, limit: 20 });
    expect(screen.getByText(/step-2 raw output/)).toBeTruthy();
    expect(screen.getByText(/#1/)).toBeTruthy();
    expect(screen.getAllByText(/progress/).length).toBeGreaterThan(0);
  });

  it('「加载更多」带 offset=已加载数再调，到底后隐藏', async () => {
    mockTranscriptGet.mockResolvedValue({
      data: { workUnitId: 'wu-1', total: 25, offset: 0, limit: 20, entries: Array.from({ length: 20 }, (_, i) => entry(i + 1)) },
    });
    render(<TranscriptViewer workUnitId="wu-1" />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByText(/step-1 raw output/)).toBeTruthy());

    mockTranscriptGet.mockResolvedValue({
      data: { workUnitId: 'wu-1', total: 25, offset: 20, limit: 20, entries: [entry(21), entry(22), entry(23), entry(24), entry(25)] },
    });
    fireEvent.click(screen.getByText('加载更多'));
    await waitFor(() => expect(screen.getByText(/step-21 raw output/)).toBeTruthy());
    expect(mockTranscriptGet).toHaveBeenNthCalledWith(2, 'wu-1', { offset: 20, limit: 20 });
    // 已加载 25 = total 25 → 按钮隐藏
    await waitFor(() => expect(screen.queryByText('加载更多')).toBeNull());
  });

  it('空结果：显示「暂无 transcript」', async () => {
    mockTranscriptGet.mockResolvedValue({
      data: { workUnitId: 'wu-1', total: 0, offset: 0, limit: 20, entries: [] },
    });
    render(<TranscriptViewer workUnitId="wu-1" />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByText(/暂无 transcript/)).toBeTruthy());
  });

  it('加载失败：显示错误文案', async () => {
    mockTranscriptGet.mockRejectedValue(new Error('boom'));
    render(<TranscriptViewer workUnitId="wu-1" />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByText(/加载失败/)).toBeTruthy());
  });
});
