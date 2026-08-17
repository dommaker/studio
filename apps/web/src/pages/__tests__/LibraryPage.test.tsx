// #155 T5: LibraryPage 阅览室 — 聚合列表 + 搜索 + 项目筛选 + legacy 徽标
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { mockLibraryList, mockProjectList, mockCompanyList } = vi.hoisted(() => ({
  mockLibraryList: vi.fn(),
  mockProjectList: vi.fn(),
  mockCompanyList: vi.fn(),
}));

vi.mock('../../api', () => ({
  libraryApi: { list: mockLibraryList },
  projectApi: { list: mockProjectList },
}));

vi.mock('../../api/company', () => ({
  companyApi: { list: mockCompanyList },
}));

vi.mock('../../api/maintenance', () => ({
  maintenanceApi: { getCosts: vi.fn().mockRejectedValue(new Error('skip')), fireTrigger: vi.fn() },
}));

vi.mock('../../components/ui', () => ({
  ManualTaskButton: () => null,
}));

import { LibraryPage } from '../LibraryPage';

const DOCS = [
  {
    id: 'proj-a:specs/spec-a.md',
    title: '规格甲',
    kind: 'spec',
    legacy: false,
    projectId: 'proj-a',
    pmoNumber: 'PMO-1',
    path: 'specs/spec-a.md',
    updatedAt: '2026-08-01T00:00:00Z',
  },
  {
    id: 'proj-a:legacy-sdd/old-doc',
    title: '遗产文档',
    kind: 'legacy',
    legacy: true,
    projectId: 'proj-a',
    pmoNumber: 'PMO-1',
    path: 'legacy-sdd/old-doc',
    status: 'done',
    tags: ['sdd'],
    updatedAt: '2026-07-01T00:00:00Z',
  },
];

describe('LibraryPage（#155 T5 阅览室）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLibraryList.mockResolvedValue({ data: { data: DOCS } });
    mockCompanyList.mockResolvedValue({ data: { data: [{ id: 'co-1' }] } });
    mockProjectList.mockResolvedValue({
      data: { data: [{ id: 'proj-a', pmoNumber: 'PMO-1', title: '项目甲' }] },
    });
  });

  const renderPage = () =>
    render(
      <MemoryRouter>
        <LibraryPage />
      </MemoryRouter>,
    );

  it('页标题为「阅览室」，挂载即全量拉取', async () => {
    renderPage();

    expect(screen.getByText('阅览室')).toBeTruthy();
    await waitFor(() => expect(mockLibraryList).toHaveBeenCalledWith({}));
    expect(await screen.findByText('规格甲')).toBeTruthy();
  });

  it('legacy 文档打「遗产」徽标并展示 PMO 号', async () => {
    renderPage();

    expect(await screen.findByText('遗产文档')).toBeTruthy();
    expect(screen.getByText('遗产')).toBeTruthy();
    expect(screen.getAllByText('PMO-1').length).toBeGreaterThan(0);
    expect(screen.getByText('已完成')).toBeTruthy();
  });

  it('项目下拉变更后带 project 参数重新拉取', async () => {
    renderPage();

    const select = await screen.findByRole('combobox');
    await waitFor(() => expect(screen.getByText('PMO-1 项目甲')).toBeTruthy());

    fireEvent.change(select, { target: { value: 'proj-a' } });

    await waitFor(
      () => expect(mockLibraryList).toHaveBeenCalledWith({ project: 'proj-a' }),
      { timeout: 1000 },
    );
  });

  it('搜索输入防抖后带 search 参数拉取', async () => {
    renderPage();

    fireEvent.change(screen.getByPlaceholderText('搜索文档标题或内容...'), { target: { value: '规格' } });

    await waitFor(
      () => expect(mockLibraryList).toHaveBeenCalledWith({ search: '规格' }),
      { timeout: 1000 },
    );
  });
});
