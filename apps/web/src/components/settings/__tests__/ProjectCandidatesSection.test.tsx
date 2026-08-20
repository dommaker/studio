// #266（决策 #258）：设置页「工程候选管理」section — 工程列表项可标记/取消「不再作为候选」，
// 保存走 PUT /projects/exclude（保存后服务端主动 invalidateCache，归属问答即时生效）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { mockDiscover, mockGetExclude, mockSaveExclude } = vi.hoisted(() => ({
  mockDiscover: vi.fn(),
  mockGetExclude: vi.fn(),
  mockSaveExclude: vi.fn(),
}));

vi.mock('../../../api/projects', () => ({
  projectsApi: {
    discover: mockDiscover,
    getExclude: mockGetExclude,
    saveExclude: mockSaveExclude,
  },
}));

import { ProjectCandidatesSection } from '../ProjectCandidatesSection';

const PROJECTS = [
  { name: 'studio', path: '/root/projects/studio', hasClaudeMd: true },
  { name: 'studio-prod', path: '/root/projects/studio-prod', hasClaudeMd: true },
];

describe('#266: ProjectCandidatesSection 工程候选管理', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDiscover.mockResolvedValue({ data: { success: true, data: PROJECTS } });
    mockGetExclude.mockResolvedValue({ data: { success: true, data: { exclude: ['/root/projects/studio-prod'] } } });
    mockSaveExclude.mockResolvedValue({ data: { success: true, data: { exclude: [] } } });
  });

  it('渲染候选工程列表与已排除规则（被排除项标记状态）', async () => {
    render(<ProjectCandidatesSection />);

    await waitFor(() => expect(screen.getByText('studio')).toBeTruthy());
    expect(screen.getByText('/root/projects/studio')).toBeTruthy();
    // 已排除规则单独列出，可恢复
    await waitFor(() => expect(screen.getByText('/root/projects/studio-prod')).toBeTruthy());
    expect(screen.getByText('恢复候选')).toBeTruthy();
    expect(screen.getByText('不再作为候选')).toBeTruthy();
  });

  it('点击「不再作为候选」→ 保存追加该工程路径的排除清单', async () => {
    render(<ProjectCandidatesSection />);
    await waitFor(() => expect(screen.getByText('studio')).toBeTruthy());

    fireEvent.click(screen.getByText('不再作为候选'));

    await waitFor(() =>
      expect(mockSaveExclude).toHaveBeenCalledWith([
        '/root/projects/studio-prod',
        '/root/projects/studio',
      ]),
    );
  });

  it('点击「恢复候选」→ 保存移除该规则后的清单', async () => {
    render(<ProjectCandidatesSection />);
    await waitFor(() => expect(screen.getByText('恢复候选')).toBeTruthy());

    fireEvent.click(screen.getByText('恢复候选'));

    await waitFor(() => expect(mockSaveExclude).toHaveBeenCalledWith([]));
  });

  it('保存成功后本地状态更新：被排除工程移到已排除区', async () => {
    mockSaveExclude.mockResolvedValue({
      data: { success: true, data: { exclude: ['/root/projects/studio-prod', '/root/projects/studio'] } },
    });
    render(<ProjectCandidatesSection />);
    await waitFor(() => expect(screen.getByText('studio')).toBeTruthy());

    fireEvent.click(screen.getByText('不再作为候选'));

    // 保存成功后候选区不再有「不再作为候选」按钮（两个工程均已排除）
    await waitFor(() => expect(screen.queryByText('不再作为候选')).toBeNull());
    expect(screen.getAllByText('恢复候选')).toHaveLength(2);
  });
});
