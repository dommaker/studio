// #155 T5: LibraryDocPage 阅览室详情 — 只读渲染 + legacy 三段
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const { mockGetDoc } = vi.hoisted(() => ({ mockGetDoc: vi.fn() }));

vi.mock('../../api', () => ({
  libraryApi: { getDoc: mockGetDoc },
}));

import { LibraryDocPage } from '../LibraryDocPage';

function renderDoc(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/library/${encodeURIComponent(id)}`]}>
      <Routes>
        <Route path="/library/:id" element={<LibraryDocPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('LibraryDocPage（#155 T5 只读详情）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('普通文档：渲染标题/PMO 号/路径/正文，无编辑按钮', async () => {
    mockGetDoc.mockResolvedValue({
      data: {
        data: {
          id: 'proj-a:specs/spec-a.md',
          title: '规格甲',
          kind: 'spec',
          legacy: false,
          projectId: 'proj-a',
          pmoNumber: 'PMO-1',
          path: 'specs/spec-a.md',
          content: '规格正文内容',
          updatedAt: '2026-08-01T00:00:00Z',
        },
      },
    });

    renderDoc('proj-a:specs/spec-a.md');

    expect(await screen.findByText('规格甲')).toBeTruthy();
    expect(screen.getByText('PMO-1')).toBeTruthy();
    expect(screen.getByText('specs/spec-a.md')).toBeTruthy();
    expect(await screen.findByText('规格正文内容')).toBeTruthy();
    expect(screen.queryByText('编辑')).toBeNull();
    expect(mockGetDoc).toHaveBeenCalledWith('proj-a:specs/spec-a.md');
  });

  it('legacy 文档：遗产徽标 + requirement/design/task 三段', async () => {
    mockGetDoc.mockResolvedValue({
      data: {
        data: {
          id: 'proj-a:legacy-sdd/old-doc',
          title: '遗产文档',
          kind: 'legacy',
          legacy: true,
          projectId: 'proj-a',
          pmoNumber: 'PMO-1',
          path: 'legacy-sdd/old-doc',
          content: '需求段',
          requirement: '需求段',
          design: '设计段',
          task: '任务段',
          status: 'done',
          updatedAt: '2026-07-01T00:00:00Z',
        },
      },
    });

    renderDoc('proj-a:legacy-sdd/old-doc');

    expect(await screen.findByText('遗产文档')).toBeTruthy();
    expect(screen.getByText('遗产（只读归档）')).toBeTruthy();
    expect(screen.getByText('需求')).toBeTruthy();
    expect(screen.getByText('设计')).toBeTruthy();
    expect(screen.getByText('任务')).toBeTruthy();
    expect(await screen.findByText('需求段')).toBeTruthy();
    expect(await screen.findByText('设计段')).toBeTruthy();
    expect(await screen.findByText('任务段')).toBeTruthy();
  });

  it('legacy 缺层时对应段不渲染', async () => {
    mockGetDoc.mockResolvedValue({
      data: {
        data: {
          id: 'proj-a:legacy-sdd/old-doc',
          title: '遗产文档',
          kind: 'legacy',
          legacy: true,
          projectId: 'proj-a',
          pmoNumber: 'PMO-1',
          path: 'legacy-sdd/old-doc',
          content: '需求段',
          requirement: '需求段',
          design: null,
          task: null,
          updatedAt: '',
        },
      },
    });

    renderDoc('proj-a:legacy-sdd/old-doc');

    expect(await screen.findByText('需求段')).toBeTruthy();
    expect(screen.queryByText('设计')).toBeNull();
    expect(screen.queryByText('任务')).toBeNull();
  });

  it('文档不存在：显示未找到与返回入口', async () => {
    mockGetDoc.mockResolvedValue({ data: { data: null } });

    renderDoc('proj-x:specs/no.md');

    expect(await screen.findByText('文档未找到')).toBeTruthy();
    expect(screen.getByText('返回列表')).toBeTruthy();
  });
});
