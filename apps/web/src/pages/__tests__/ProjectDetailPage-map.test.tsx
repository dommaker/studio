// #114 T8: ProjectDetailPage 地图区 + 下一个该干什么 集成测试
// （地图区四块渲染 / 徽章按决策单真实状态 / 下一个该干什么排序与归属过滤 / 非探路型不渲染）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const {
  mockGetProject,
  mockGetDelivery,
  mockGetChain,
  mockGetAgentSummary,
  mockListByProject,
  mockWuList,
  mockWuGet,
} = vi.hoisted(() => ({
  mockGetProject: vi.fn(),
  mockGetDelivery: vi.fn(),
  mockGetChain: vi.fn(),
  mockGetAgentSummary: vi.fn(),
  mockListByProject: vi.fn(),
  mockWuList: vi.fn(),
  mockWuGet: vi.fn(),
}));

vi.mock('../../api', () => ({
  api: { get: vi.fn().mockResolvedValue({ data: [] }), post: vi.fn() },
  projectApi: { get: mockGetProject, getDelivery: mockGetDelivery, deliver: vi.fn() },
}));
vi.mock('../../api/workunit', () => ({
  workunitApi: { list: mockWuList, get: mockWuGet },
}));
vi.mock('../../api/requirements', () => ({
  requirementApi: { getChain: mockGetChain },
}));
vi.mock('../../api/monitoring', () => ({
  monitoringApi: { getAgentSummary: mockGetAgentSummary },
}));
vi.mock('../../api/knowledge', () => ({
  knowledgeApi: { listByProject: mockListByProject, getDetail: vi.fn() },
}));
vi.mock('../../components/knowledge/MarkdownBody', () => ({
  default: ({ content }: { content: string }) => <div>{content}</div>,
}));

import { ProjectDetailPage } from '../ProjectDetailPage';

const mockProject = {
  id: 'p1',
  pmoNumber: 'PMO-11',
  title: '探路项目',
  status: 'active',
  priority: 'normal',
  progress: 10,
  reqAlias: 'REQ-0011',
  deliveryPolicy: 'branch-only',
  createdAt: '2026-08-01',
  map: {
    destination: '把订单系统拆成前后台两条线',
    decisions: [
      { wuId: 'wu-d1', summary: '存储沿用 Postgres', resolvedAt: '2026-08-01T09:00:00Z' },
    ],
    fog: [
      { id: 'fog-1', question: '存储选型？', wuId: 'wu-d1', status: 'resolved' },
      { id: 'fog-2', question: '队列方案？', wuId: 'wu-d2', status: 'open' },
      { id: 'fog-3', question: '鉴权要不要重做？', wuId: null, status: 'open' },
    ],
  },
};

const chainWorkunits = [
  { id: 'wu-t1', title: '拆读模型', status: 'done', assigneeId: null, metadata: null, type: 'task', createdAt: '2026-08-01T08:00:00Z' },
  {
    id: 'wu-t2', title: '拆写模型', status: 'unassigned', assigneeId: null, type: 'task', createdAt: '2026-08-02T08:00:00Z',
    metadata: JSON.stringify({ blockedBy: ['wu-t1'], pmoId: 'p1' }),
  },
];

// 列表 API 未指派单（claimable 由服务端打好）：本 PMO 的决策单 + 别的 PMO 的单 + 依赖未清的单
const unassignedRows = [
  {
    id: 'wu-d2', type: 'decision', scope: '待决问题 PMO-11: 队列方案？', createdAt: '2026-08-02T09:00:00Z',
    metadata: JSON.stringify({ pmoId: 'p1', fogId: 'fog-2' }), claimable: true,
  },
  {
    id: 'wu-other', type: 'task', scope: '别的项目的活', createdAt: '2026-08-01T07:00:00Z',
    metadata: JSON.stringify({ pmoId: 'p-other' }), claimable: true,
  },
  {
    id: 'wu-t2', type: 'task', scope: '拆写模型', createdAt: '2026-08-02T08:00:00Z',
    metadata: JSON.stringify({ pmoId: 'p1', blockedBy: ['wu-t1'] }), claimable: false,
  },
];

const renderDetail = () =>
  render(
    <MemoryRouter initialEntries={['/pmo/project/p1']}>
      <Routes>
        <Route path="/pmo/project/:projectId" element={<ProjectDetailPage />} />
        <Route path="/workunits/:id" element={<div>WU 详情页</div>} />
      </Routes>
    </MemoryRouter>,
  );

describe('#114：PMO 地图区 + 下一个该干什么', { testTimeout: 15000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProject.mockResolvedValue({ data: mockProject });
    mockGetDelivery.mockRejectedValue(new Error('no delivery'));
    mockGetChain.mockResolvedValue({
      data: { data: { requirement: { id: 'REQ-0011', title: '探路' }, workunits: chainWorkunits } },
    });
    mockGetAgentSummary.mockResolvedValue({ data: { agents: [] } });
    mockListByProject.mockResolvedValue({ data: { documents: [] } });
    mockWuList.mockResolvedValue({ data: { data: unassignedRows, total: 3 } });
    mockWuGet.mockImplementation((id: string) => {
      if (id === 'wu-d2') return Promise.resolve({ data: { id, status: 'in_review' } });
      return Promise.reject(new Error('not found'));
    });
  });

  it('地图区：目标 / 待决问题（徽章按决策单真实状态）/ 结论时间线 / 依赖图', async () => {
    renderDetail();

    await waitFor(() => expect(screen.getByText('🗺️ 地图')).toBeTruthy());
    expect(screen.getByText('把订单系统拆成前后台两条线')).toBeTruthy();

    // 徽章：fog-1 已定；fog-2 决策单 wu-d2 在审（workunitApi.get 拉回 in_review）→ 待确认；fog-3 未建单 → 待认领
    await waitFor(() => expect(screen.getByText('待确认')).toBeTruthy());
    expect(screen.getByText('已定')).toBeTruthy();
    expect(screen.getByText('待认领')).toBeTruthy();
    expect(mockWuGet).toHaveBeenCalledWith('wu-d2');

    // 结论时间线可点进决策单
    fireEvent.click(screen.getByRole('button', { name: '存储沿用 Postgres' }));
    await screen.findByText('WU 详情页');
  });

  it('依赖图：拆写模型等拆读模型（已完成的不再拦路）', async () => {
    renderDetail();
    await waitFor(() => expect(screen.getByText('🔗 任务单依赖')).toBeTruthy());
    expect(screen.getByRole('button', { name: '拆写模型' })).toBeTruthy();
    expect(screen.getByText(/拆读模型（已完成）/)).toBeTruthy();
  });

  it('下一个该干什么：本 PMO 可认领的决策单（他 PMO 与依赖未清的不算）', async () => {
    renderDetail();

    await waitFor(() => expect(screen.getByText('👉 下一个该干什么')).toBeTruthy());
    expect(screen.getByRole('button', { name: '待决问题 PMO-11: 队列方案？' })).toBeTruthy();
    expect(screen.getByText('先拍板这个待决问题')).toBeTruthy();
    expect(screen.queryByText('别的项目的活')).toBeNull();
  });

  it('非探路型（无 map）不渲染地图区；有可认领单仍显示下一个该干什么', async () => {
    mockGetProject.mockResolvedValue({ data: { ...mockProject, map: null } });
    mockWuList.mockResolvedValue({
      data: {
        data: [{
          id: 'wu-t9', type: 'task', scope: '独立任务', createdAt: '2026-08-03T00:00:00Z',
          metadata: JSON.stringify({ pmoId: 'p1', title: '独立任务' }), claimable: true,
        }],
        total: 1,
      },
    });
    renderDetail();

    await waitFor(() => expect(screen.getByText('探路项目')).toBeTruthy());
    expect(screen.queryByText('🗺️ 地图')).toBeNull();
    await waitFor(() => expect(screen.getByText('👉 下一个该干什么')).toBeTruthy());
    expect(screen.getByText('可以认领开工')).toBeTruthy();
  });

  it('列表/决策单拉取失败 → 页面照常渲染，地图徽章按待认领兜底', async () => {
    mockWuList.mockRejectedValue(new Error('boom'));
    mockWuGet.mockRejectedValue(new Error('boom'));
    renderDetail();

    await waitFor(() => expect(screen.getByText('🗺️ 地图')).toBeTruthy());
    // 下一个该干什么空态
    expect(screen.getByText('暂无可认领的任务（依赖未清或都已有人在做）')).toBeTruthy();
    // fog-2 状态拉不到 → 待认领兜底（fog-1 已定不受影响）
    expect(screen.getByText('已定')).toBeTruthy();
    expect(screen.getAllByText('待认领').length).toBeGreaterThan(0);
  });
});
