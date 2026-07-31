// AC-5: DocReaderDrawer 测试 — 开关 / 加载态 / 内容渲染 / 错误态
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { mockGetDetail } = vi.hoisted(() => ({ mockGetDetail: vi.fn() }));

vi.mock('../../../api/knowledge', () => ({
  knowledgeApi: { getDetail: mockGetDetail },
}));

import { DocReaderDrawer } from '../DocReaderDrawer';

const mockDoc = {
  id: 'd1',
  projectId: 'p1',
  type: 'requirement',
  title: '需求分析文档',
  version: 2,
  status: 'active',
  content: '# 需求\n正文内容第一行',
};

describe('DocReaderDrawer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('documentId 为 null 时不渲染', () => {
    const { container } = render(<DocReaderDrawer documentId={null} onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
    expect(mockGetDetail).not.toHaveBeenCalled();
  });

  it('打开后先加载态，随后渲染标题/type/version/status + markdown 正文', async () => {
    let resolve: (v: { data: typeof mockDoc }) => void = () => {};
    mockGetDetail.mockReturnValue(new Promise(r => { resolve = r; }));
    render(<DocReaderDrawer documentId="d1" onClose={() => {}} />);

    expect(screen.getByText('加载中…')).toBeTruthy();
    await waitFor(() => {
      expect(mockGetDetail).toHaveBeenCalledWith('d1');
    });

    resolve({ data: mockDoc });
    await waitFor(() => {
      expect(screen.getByText('需求分析文档')).toBeTruthy();
    });
    expect(screen.getByText('需求')).toBeTruthy();          // type 中文化
    expect(screen.getByText('v2')).toBeTruthy();
    expect(screen.getByText('active')).toBeTruthy();
    expect(screen.getByText(/正文内容第一行/)).toBeTruthy();
  });

  it('点 × 调 onClose', async () => {
    mockGetDetail.mockResolvedValue({ data: mockDoc });
    const onClose = vi.fn();
    render(<DocReaderDrawer documentId="d1" onClose={onClose} />);

    fireEvent.click(await screen.findByLabelText('关闭抽屉'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('加载失败显示错误态', async () => {
    mockGetDetail.mockRejectedValue(new Error('boom'));
    render(<DocReaderDrawer documentId="d1" onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText(/加载失败/)).toBeTruthy();
    });
  });
});
