// #155 T5: LibraryPage 阅览室 — 聚合列表 + 搜索 + 项目筛选 + legacy 徽标
// #436 B11：内容区收 max-w-5xl（§4.7 内容档）+ 类型筛选（kind 前端过滤）
// E6：默认按项目分组（组头 pmoNumber+计数，组内 updatedAt 降序），搜索/筛选态回退平铺；页头动作去 emoji
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

vi.mock('../../components/ui', async (importOriginal) => ({
  // 部分 mock：只替 ManualTaskButton，其余（Select/SkeletonText 等）保留真实实现
  ...(await importOriginal<typeof import('../../components/ui')>()),
  ManualTaskButton: ({ label }: { label: string }) => <button>{label}</button>,
}));

import { LibraryPage } from '../LibraryPage';
import { usePmoDataStore } from '../../stores/pmoDataStore';

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
    // #456：company/project 链改读 pmoDataStore（模块级单例），每测重置避免 TTL 缓存跨测串味
    usePmoDataStore.getState().__resetForTests();
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

    const trigger = await screen.findByLabelText('项目筛选');
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('option', { name: /PMO-1 项目甲/ }));

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

  describe('#436 B11 密度与类型筛选', () => {
    it('内容区收 max-w-5xl（§4.7 内容档）', async () => {
      const { container } = renderPage();
      await screen.findByText('规格甲');
      expect(container.querySelector('.max-w-5xl')).not.toBeNull();
    });

    it('类型筛选：选定 kind 后列表只显示该类型文档', async () => {
      renderPage();
      await screen.findByText('规格甲');
      expect(screen.getByText('遗产文档')).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: '类型筛选' }));
      fireEvent.click(await screen.findByRole('option', { name: '遗产' }));

      await waitFor(() => {
        expect(screen.queryByText('规格甲')).toBeNull();
        expect(screen.getByText('遗产文档')).toBeTruthy();
      });
    });

    it('类型筛选回到「全部类型」后恢复全量', async () => {
      renderPage();
      await screen.findByText('规格甲');

      fireEvent.click(screen.getByRole('button', { name: '类型筛选' }));
      fireEvent.click(await screen.findByRole('option', { name: '遗产' }));
      await waitFor(() => expect(screen.queryByText('规格甲')).toBeNull());

      fireEvent.click(screen.getByRole('button', { name: '类型筛选' }));
      fireEvent.click(await screen.findByRole('option', { name: '全部类型' }));
      await waitFor(() => expect(screen.getByText('规格甲')).toBeTruthy());
    });
  });

  it('页头「语义审查」为次要动作且去 emoji（E6-3）', async () => {
    renderPage();

    const btn = screen.getByRole('button', { name: '语义审查' });
    expect(btn.textContent).not.toContain('🔍');
  });

  describe('批次 F-4: 空态归 .empty-state（图标 + 文案 + 说明），区分真空/筛选无结果', () => {
    it('真空态出图标 + 「暂无文档」+ 文档来源说明', async () => {
      mockLibraryList.mockResolvedValue({ data: { data: [] } });
      const { container } = renderPage();

      expect(await screen.findByText('暂无文档')).toBeTruthy();
      expect(screen.getByText(/文档来自各项目仓库的 \.studio\/ 目录/)).toBeTruthy();
      expect(container.querySelector('.empty-state .empty-icon svg')).not.toBeNull();
    });

    it('搜索无结果走筛选语境文案', async () => {
      mockLibraryList.mockResolvedValue({ data: { data: [] } });
      renderPage();
      await screen.findByText('暂无文档');

      fireEvent.change(screen.getByPlaceholderText('搜索文档标题或内容...'), { target: { value: '不存在' } });

      expect(await screen.findByText('没有匹配的文档')).toBeTruthy();
      expect(screen.getByText('调整或清除搜索/筛选条件后再查看')).toBeTruthy();
      expect(screen.queryByText('暂无文档')).toBeNull();
    });
  });

  describe('E6 列表按项目分组', () => {
    // 跨两个项目：proj-a 两条（updatedAt 乱序）+ proj-b 一条
    const GROUPED_DOCS = [
      {
        id: 'proj-a:specs/a1.md',
        title: '甲-旧',
        kind: 'spec',
        legacy: false,
        projectId: 'proj-a',
        pmoNumber: 'PMO-1',
        path: 'specs/a1.md',
        updatedAt: '2026-07-01T00:00:00Z',
      },
      {
        id: 'proj-b:adr/b1.md',
        title: '乙-文',
        kind: 'adr',
        legacy: false,
        projectId: 'proj-b',
        pmoNumber: 'PMO-2',
        path: 'adr/b1.md',
        updatedAt: '2026-07-15T00:00:00Z',
      },
      {
        id: 'proj-a:research/a2.md',
        title: '甲-新',
        kind: 'research',
        legacy: false,
        projectId: 'proj-a',
        pmoNumber: 'PMO-1',
        path: 'research/a2.md',
        updatedAt: '2026-08-01T00:00:00Z',
      },
    ];

    beforeEach(() => {
      mockLibraryList.mockResolvedValue({ data: { data: GROUPED_DOCS } });
    });

    it('默认视图按项目分组：组头 = pmoNumber + 计数，组内 updatedAt 降序、组间按组内最新降序', async () => {
      renderPage();

      expect(await screen.findByText('PMO-1 · 2 篇')).toBeTruthy();
      expect(screen.getByText('PMO-2 · 1 篇')).toBeTruthy();
      // 文档标题（.lib-title 行标题）DOM 顺序 = 渲染顺序：PMO-1 组（最新 8/1）在前，组内 新→旧
      const titles = [...document.querySelectorAll('.lib-title')].map((h) => h.textContent);
      expect(titles).toEqual(['甲-新', '甲-旧', '乙-文']);
    });

    it('搜索态回退平铺：无组头', async () => {
      renderPage();
      await screen.findByText('甲-新');

      fireEvent.change(screen.getByPlaceholderText('搜索文档标题或内容...'), { target: { value: '规格' } });
      await waitFor(
        () => expect(mockLibraryList).toHaveBeenCalledWith({ search: '规格' }),
        { timeout: 1000 },
      );
      await waitFor(() => expect(screen.queryByText('PMO-1 · 2 篇')).toBeNull());
      expect(screen.getByText('甲-新')).toBeTruthy();
      expect(screen.getByText('乙-文')).toBeTruthy();
    });

    it('项目筛选态回退平铺：无组头', async () => {
      renderPage();
      await screen.findByText('甲-新');

      fireEvent.click(await screen.findByLabelText('项目筛选'));
      fireEvent.click(await screen.findByRole('option', { name: /PMO-1 项目甲/ }));
      await waitFor(
        () => expect(mockLibraryList).toHaveBeenCalledWith({ project: 'proj-a' }),
        { timeout: 1000 },
      );
      await waitFor(() => expect(screen.queryByText('PMO-1 · 2 篇')).toBeNull());
      expect(screen.getByText('甲-新')).toBeTruthy();
    });

    it('类型筛选态回退平铺：无组头', async () => {
      renderPage();
      await screen.findByText('甲-新');

      fireEvent.click(screen.getByRole('button', { name: '类型筛选' }));
      fireEvent.click(await screen.findByRole('option', { name: '规格' }));
      await waitFor(() => {
        expect(screen.queryByText('PMO-1 · 2 篇')).toBeNull();
        expect(screen.getByText('甲-旧')).toBeTruthy();
        expect(screen.queryByText('乙-文')).toBeNull(); // kind=spec 过滤掉 adr
      });
    });
  });

  describe('批次 F-1: 加载失败错误条 + 重试（原先 catch 只 console.error，落「暂无文档」假空态）', () => {
    it('fetchDocs 失败显示错误条与重试按钮，不落「暂无文档」假空态', async () => {
      mockLibraryList.mockRejectedValue(new Error('boom'));
      renderPage();

      expect(await screen.findByText('加载文档列表失败，请重试')).toBeTruthy();
      expect(screen.getByText('重试')).toBeTruthy();
      expect(screen.queryByText('暂无文档')).toBeNull();
    });

    it('点击重试重新发起请求并恢复列表、清除错误条', async () => {
      mockLibraryList
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValue({ data: { data: DOCS } });
      renderPage();

      fireEvent.click(await screen.findByText('重试'));

      expect(await screen.findByText('规格甲')).toBeTruthy();
      expect(screen.queryByText('加载文档列表失败，请重试')).toBeNull();
      await waitFor(() => expect(mockLibraryList).toHaveBeenCalledTimes(2));
    });
  });
});
