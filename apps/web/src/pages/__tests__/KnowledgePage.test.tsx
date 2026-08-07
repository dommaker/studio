// 工单 38: KnowledgePage 手动新建条目 — 失败 toast 反馈且表单保留（原先仅 console.error 静默）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { mockListUnified, mockCreateUnifiedEntry } = vi.hoisted(() => ({
  mockListUnified: vi.fn(),
  mockCreateUnifiedEntry: vi.fn(),
}));

vi.mock('../../api/knowledge', () => ({
  knowledgeApi: {
    listUnified: mockListUnified,
    createUnifiedEntry: mockCreateUnifiedEntry,
    listGaps: vi.fn().mockResolvedValue({ data: { data: [] } }),
    listResolutions: vi.fn().mockResolvedValue({ data: { resolutions: [] } }),
    search: vi.fn().mockResolvedValue({ data: { results: [] } }),
  },
}));

vi.mock('../../api/maintenance', () => ({
  maintenanceApi: {
    getCosts: vi.fn().mockResolvedValue(null),
    runKnowledgeMaintenance: vi.fn(),
    fireTrigger: vi.fn(),
  },
}));

import { KnowledgePage } from '../KnowledgePage';

describe('工单 38: KnowledgePage 新建条目失败反馈', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListUnified.mockResolvedValue({ data: { entries: [], total: 0 } });
  });

  it('创建失败时 toast 报错、表单保留且内容不清空', async () => {
    mockCreateUnifiedEntry.mockRejectedValue(new Error('server down'));
    render(
      <MemoryRouter>
        <KnowledgePage />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByText('+ 新建'));
    fireEvent.change(screen.getByPlaceholderText('标题'), { target: { value: '踩坑记录' } });
    fireEvent.change(screen.getByPlaceholderText('内容'), { target: { value: '不要在生产环境直接改库' } });
    fireEvent.click(screen.getByText('保存'));

    // toast.error 兜底文案（toast 挂在 document.body）
    expect(await screen.findByText('server down')).toBeTruthy();
    // 表单不关闭、输入内容保留，用户可修正后重试
    expect((screen.getByPlaceholderText('标题') as HTMLInputElement).value).toBe('踩坑记录');
    expect((screen.getByPlaceholderText('内容') as HTMLTextAreaElement).value).toBe('不要在生产环境直接改库');
  });

  it('创建成功后关闭表单并刷新列表', async () => {
    mockCreateUnifiedEntry.mockResolvedValue({ data: {} });
    render(
      <MemoryRouter>
        <KnowledgePage />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByText('+ 新建'));
    fireEvent.change(screen.getByPlaceholderText('标题'), { target: { value: '指南' } });
    fireEvent.change(screen.getByPlaceholderText('内容'), { target: { value: '内容' } });
    fireEvent.click(screen.getByText('保存'));

    await waitFor(() => expect(screen.queryByPlaceholderText('标题')).toBeNull());
    expect(mockCreateUnifiedEntry).toHaveBeenCalledTimes(1);
    // 初次加载 + 成功后刷新各一次
    await waitFor(() => expect(mockListUnified).toHaveBeenCalledTimes(2));
  });

  it('提交中保存按钮禁用（loading 态），连点只提交一次', async () => {
    let resolveCreate: (v: any) => void;
    mockCreateUnifiedEntry.mockImplementation(
      () => new Promise(resolve => { resolveCreate = resolve; })
    );
    render(
      <MemoryRouter>
        <KnowledgePage />
      </MemoryRouter>
    );

    fireEvent.click(screen.getByText('+ 新建'));
    fireEvent.change(screen.getByPlaceholderText('标题'), { target: { value: '指南' } });
    fireEvent.change(screen.getByPlaceholderText('内容'), { target: { value: '内容' } });

    fireEvent.click(screen.getByText('保存'));
    fireEvent.click(screen.getByText('保存中...'));

    expect(mockCreateUnifiedEntry).toHaveBeenCalledTimes(1);
    expect(screen.getByText('保存中...').closest('button')!.disabled).toBe(true);

    resolveCreate!({ data: {} });
    await waitFor(() => expect(screen.queryByPlaceholderText('标题')).toBeNull());
  });
});
