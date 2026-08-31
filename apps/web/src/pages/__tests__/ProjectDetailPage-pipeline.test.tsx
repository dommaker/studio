// AC-5: ProjectDetailPage 驾驶舱测试 — 头部增强 / 进度管道 / 项目动态 / 跳转
// #149（2026-08-15）：文档阅读器相关测试随 document-store 退役移除
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const {
  mockApiGet,
  mockApiPost,
  mockGetProject,
  mockGetDelivery,
  mockDeliver,
  mockGetChain,
  mockVerify,
  mockDispatchReview,
  mockReviewPassed,
  mockGetAgentSummary,
} = vi.hoisted(() => ({
  mockApiGet: vi.fn(),
  mockApiPost: vi.fn(),
  mockGetProject: vi.fn(),
  mockGetDelivery: vi.fn(),
  mockDeliver: vi.fn(),
  mockGetChain: vi.fn(),
  mockVerify: vi.fn(),
  mockDispatchReview: vi.fn(),
  mockReviewPassed: vi.fn(),
  mockGetAgentSummary: vi.fn(),
}));

vi.mock('../../api', () => ({
  api: { get: mockApiGet, post: mockApiPost },
  projectApi: { get: mockGetProject, getDelivery: mockGetDelivery, deliver: mockDeliver },
}));
vi.mock('../../api/workunit', () => ({
  workunitApi: {
    verify: mockVerify,
    dispatchReview: mockDispatchReview,
    reviewPassed: mockReviewPassed,
    // #114：下一个该干什么 / 决策单状态（默认空，地图测试单独覆写）
    list: vi.fn().mockResolvedValue({ data: { data: [], total: 0 } }),
    get: vi.fn().mockRejectedValue(new Error('not found')),
  },
}));
vi.mock('../../api/requirements', () => ({
  requirementApi: { getChain: mockGetChain },
}));
vi.mock('../../api/monitoring', () => ({
  monitoringApi: { getAgentSummary: mockGetAgentSummary },
}));

import { ProjectDetailPage } from '../ProjectDetailPage';

const attestMeta = JSON.stringify({
  attestations: {
    l1: { verdict: 'approved', by: 'dev', at: '2026-07-10T10:00:00Z', kind: 'verify' },
    l2: { verdict: 'approved', by: 'qa', at: '2026-07-10T11:00:00Z', kind: 'agent-review' },
    l3: { verdict: 'approved', by: 'human', at: '2026-07-11T09:00:00Z', kind: 'human-confirm' },
  },
});

const mockProject = {
  id: 'p1',
  pmoNumber: 'PMO-11',
  title: '驾驶舱项目',
  description: '项目描述',
  requirement: '做一个驾驶舱页面，展示进度管道与文档',
  status: 'active',
  priority: 'high',
  progress: 40,
  reqAlias: 'REQ-0011',
  channelId: 'ch-1',
  deliveryPolicy: 'branch-only',
  createdAt: '2026-07-01',
};

// §10：chain 条目自带 type/createdAt/claimedAt/completedAt（原 wuDetails N+1 补全已移除）
const chainWorkunits = [
  {
    id: 'wu-1', title: '设计管道 UI', status: 'done', assigneeId: 'inst-1', metadata: attestMeta,
    type: 'task', createdAt: '2026-07-09T08:00:00Z', claimedAt: '2026-07-10T09:00:00Z', completedAt: '2026-07-11T10:00:00Z',
  },
  {
    id: 'wu-2', title: '实现分组逻辑', status: 'active', assigneeId: 'inst-2', metadata: null,
    type: 'feature', createdAt: '2026-07-10T08:00:00Z', claimedAt: '2026-07-10T10:00:00Z', completedAt: null,
  },
  {
    id: 'wu-3', title: '写测试', status: 'unassigned', assigneeId: null, metadata: null,
    type: 'task', createdAt: '2026-07-11T08:00:00Z', claimedAt: null, completedAt: null,
  },
];

const mockAgents = [
  { id: 'inst-1', roleId: 'role-dev', name: 'dev', status: 'idle', currentWorkUnitId: null, startedAt: '2026-07-01' },
  { id: 'inst-2', roleId: 'role-qa', name: 'qa', status: 'active', currentWorkUnitId: 'wu-2', startedAt: '2026-07-01' },
];

const renderDetail = () =>
  render(
    <MemoryRouter initialEntries={['/pmo/project/p1']}>
      <Routes>
        <Route path="/pmo/project/:projectId" element={<ProjectDetailPage />} />
        <Route path="/workunits/:id" element={<div>WU 详情页</div>} />
        <Route path="/channels/:id" element={<div>频道页</div>} />
        <Route path="/agents/:profileId" element={<div>Agent 详情页</div>} />
      </Routes>
    </MemoryRouter>,
  );

describe('AC-5: PMO 驾驶舱', { testTimeout: 15000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProject.mockResolvedValue({ data: mockProject });
    mockApiGet.mockImplementation((url: string) => {
      if (url.includes('/tasks')) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
    mockApiPost.mockResolvedValue({ data: {} });
    mockGetDelivery.mockRejectedValue(new Error('no delivery'));
    mockGetChain.mockResolvedValue({
      data: { data: { requirement: { id: 'REQ-0011', title: '驾驶舱' }, workunits: chainWorkunits } },
    });
    mockGetAgentSummary.mockResolvedValue({
      data: { agents: mockAgents, summary: { total: 2, idle: 1, active: 1, error: 0, terminated: 0 } },
    });
  });

  it('头部：原始需求块 + 状态 stepper（当前阶段高亮）+ 去频道', async () => {
    renderDetail();

    await waitFor(() => {
      expect(screen.getByText('🚦 进度管道')).toBeTruthy();
    });

    // 原始需求可折叠块（短文本全量显示，无展开按钮）
    expect(screen.getByText('原始需求')).toBeTruthy();
    expect(screen.getByText('做一个驾驶舱页面，展示进度管道与文档')).toBeTruthy();

    // stepper 四阶段（#399 §8.3 项目阶段专用词：讨论→开发→验收→交付）；active 为当前阶段（高亮 pill）
    expect(screen.getByText('讨论')).toBeTruthy();
    expect(screen.getByText('验收')).toBeTruthy();
    expect(screen.getByText('交付')).toBeTruthy();
    const current = screen.getByText('开发', { selector: 'span.rounded-full' });
    expect(current.className).toContain('u-accent-bg');

    // 去频道按钮（channelId 存在时）
    expect(screen.getByRole('button', { name: /去频道/ })).toBeTruthy();
  });

  it('进度管道：总进度 x/y + 五泳道分组 + WU 小卡（类型/状态/证据徽章/认领人/耗时）', async () => {
    renderDetail();

    await waitFor(() => {
      expect(screen.getByText('1/3 任务完成 · 33%')).toBeTruthy();
    });

    // 五泳道计数（#399 §8.3 词表：待领取/进行中/待验收/完成）
    expect(screen.getByText('待领取 (1)')).toBeTruthy();
    expect(screen.getByText('进行中 (1)')).toBeTruthy();
    expect(screen.getByText('待验收 (0)')).toBeTruthy();
    expect(screen.getByText('阻塞 (0)')).toBeTruthy();
    expect(screen.getByText('完成 (1)')).toBeTruthy();

    // wu-1 小卡：类型 chip / 状态 / 证据徽章白话词表（自动验证/Agent 评审/人工确认）/ 名册解析的认领人 / 耗时（25h → 1d1h）
    expect(screen.getByText('设计管道 UI')).toBeTruthy();
    expect(screen.getByText('自动验证✓')).toBeTruthy();
    expect(screen.getByText('Agent 评审✓')).toBeTruthy();
    expect(screen.getByText('人工确认✓')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'dev' })).toBeTruthy();
    expect(screen.getByText('⏱ 1d1h')).toBeTruthy();

    // wu-3 未领取
    expect(screen.getByText('写测试')).toBeTruthy();
    expect(screen.getByText('未领取')).toBeTruthy();
  });

  it('WU 小卡点击 → /workunits/:id；认领人点击 → /agents/:roleId；去频道 → /channels/:id', async () => {
    renderDetail();
    await waitFor(() => expect(screen.getByText('设计管道 UI')).toBeTruthy());

    fireEvent.click(screen.getByText('设计管道 UI'));
    await screen.findByText('WU 详情页');
  });

  it('认领人名点击跳 agent 详情（不触发卡片跳转）', async () => {
    renderDetail();
    await waitFor(() => expect(screen.getByRole('button', { name: 'dev' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'dev' }));
    await screen.findByText('Agent 详情页');
  });

  it('去频道按钮跳频道页', async () => {
    renderDetail();
    await waitFor(() => expect(screen.getByRole('button', { name: /去频道/ })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /去频道/ }));
    await screen.findByText('频道页');
  });

  it('#273：未绑定频道（channelId 缺失）时不渲染去频道按钮', async () => {
    mockGetProject.mockResolvedValue({ data: { ...mockProject, channelId: null } });
    renderDetail();

    await waitFor(() => expect(screen.getByText('🚦 进度管道')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /去频道/ })).toBeNull();
  });

  it('项目动态：领取/完成/新增条目拼装，标题可点跳 WU 详情', async () => {
    renderDetail();
    await waitFor(() => expect(screen.getByText(/项目动态/)).toBeTruthy());

    // 「dev 领取了「设计管道 UI」」（文本跨节点，按 li textContent 断言）
    await waitFor(() => {
      const li = screen.getByText((_, el) =>
        el?.tagName === 'LI' && (el.textContent ?? '').includes('dev 领取了 「设计管道 UI」'));
      expect(li).toBeTruthy();
    });
    // 完成条目（done 正词即「完成」，不再赘述（已完成）后缀）
    expect(screen.getByText((_, el) =>
      el?.tagName === 'LI' && (el.textContent ?? '').includes('「设计管道 UI」 完成'))).toBeTruthy();
    // 新增条目
    expect(screen.getByText((_, el) =>
      el?.tagName === 'LI' && (el.textContent ?? '').includes('新增 「写测试」'))).toBeTruthy();

    // 动态里的标题可点击 → WU 详情
    fireEvent.click(screen.getAllByRole('button', { name: '「设计管道 UI」' })[0]);
    await screen.findByText('WU 详情页');
  });

  it('空态：无 WU → 管道空态；无动态 → 暂无动态', async () => {
    mockGetChain.mockResolvedValue({
      data: { data: { requirement: { id: 'REQ-0011', title: '驾驶舱' }, workunits: [] } },
    });
    renderDetail();

    await waitFor(() => {
      expect(screen.getByText('暂无任务产出')).toBeTruthy();
    });
    expect(screen.getByText('暂无动态')).toBeTruthy();
  });

  it('chain 拉取失败：管道空态，页面其余部分照常', async () => {
    mockGetChain.mockRejectedValue(new Error('boom'));
    renderDetail();

    await waitFor(() => {
      expect(screen.getByText('暂无任务产出')).toBeTruthy();
    });
    expect(screen.getByText('驾驶舱项目')).toBeTruthy();
  });
});
