// PMO-b: ProjectDetailPage 交付区块测试（台账渲染 / auto-merge 交付按钮 / branch-only 无按钮）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const { mockApiGet, mockGetProject, mockGetDelivery, mockDeliver } = vi.hoisted(() => ({
  mockApiGet: vi.fn(),
  mockGetProject: vi.fn(),
  mockGetDelivery: vi.fn(),
  mockDeliver: vi.fn(),
}));

vi.mock('../../api', () => ({
  api: {
    get: mockApiGet,
    post: vi.fn(),
  },
  projectApi: {
    get: mockGetProject,
    getDelivery: mockGetDelivery,
    deliver: mockDeliver,
  },
}));

import { ProjectDetailPage } from '../ProjectDetailPage';

const mockProject = {
  id: 'p1',
  pmoNumber: 'PMO-11',
  title: '证据链看板',
  status: 'active',
  priority: 'high',
  progress: 60,
  createdAt: '2026-01-01',
};

// 台账 fixture：auto-merge / 未达成（带缺口清单）
const deliveryAutoMergePending = {
  projectId: 'p1',
  pmoNumber: 'PMO-11',
  branch: 'PMO-11',
  policy: 'auto-merge' as const,
  gitRepo: '/root/projects/studio',
  wu: { total: 3, finished: 2, inFlight: 1 },
  evidence: {
    l1Missing: [],
    l2Missing: ['WU-3'],
    l3Missing: [],
    selfReviewCount: 2,
  },
  deliverable: false,
  missing: ['WU-3 缺 L2 agent 评审'],
  deliveredAt: null,
  deliveredBy: null,
  deliverCommit: null,
};

// 台账 fixture：branch-only
const deliveryBranchOnly = {
  ...deliveryAutoMergePending,
  policy: 'branch-only' as const,
};

// 台账 fixture：已交付
const deliveryDelivered = {
  ...deliveryAutoMergePending,
  deliverable: true,
  missing: [],
  deliveredAt: '2026-07-29T10:00:00Z',
  deliveredBy: 'tester@example.com',
  deliverCommit: 'abcdef1234567890',
};

describe('PMO-b: 交付区块', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProject.mockResolvedValue({ data: mockProject });
    mockApiGet.mockImplementation((url: string) => {
      if (url.includes('/tasks')) return Promise.resolve({ data: [] });
      if (url.includes('/knowledge')) return Promise.resolve({ data: { documents: [] } });
      return Promise.resolve({ data: [] });
    });
    mockDeliver.mockResolvedValue({ data: { delivered: true, deliverCommit: 'abcdef1234567890' } });
  });

  const renderDetail = () =>
    render(
      <MemoryRouter initialEntries={['/pmo/project/p1']}>
        <Routes>
          <Route path="/pmo/project/:projectId" element={<ProjectDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

  it('渲染台账：策略/分支/WU 完成度/证据三层 + 缺口清单', async () => {
    mockGetDelivery.mockResolvedValue({ data: deliveryAutoMergePending });
    renderDetail();

    await waitFor(() => {
      expect(screen.getByText('📦 交付')).toBeTruthy();
    });

    expect(screen.getByText('未达成')).toBeTruthy();
    expect(screen.getByText(/自动合并/)).toBeTruthy();
    expect(screen.getByText(/分支: PMO-11/)).toBeTruthy();
    expect(screen.getByText('WU: 2/3 完成')).toBeTruthy();
    expect(screen.getByText('L1: ✓')).toBeTruthy();
    expect(screen.getByText('L2: 缺 1')).toBeTruthy();
    expect(screen.getByText('L3: ✓')).toBeTruthy();
    expect(screen.getByText('自评: 2')).toBeTruthy();
    // 缺口清单一字不落渲染
    expect(screen.getByText('WU-3 缺 L2 agent 评审')).toBeTruthy();
  });

  it('auto-merge：点击交付合并调 deliver，成功后显示已交付记录并禁用按钮', async () => {
    mockGetDelivery
      .mockResolvedValueOnce({ data: { ...deliveryAutoMergePending, deliverable: true, missing: [] } })
      .mockResolvedValue({ data: deliveryDelivered });
    renderDetail();

    const btn = await screen.findByText('交付合并');
    expect(screen.getByText('✓ 可交付')).toBeTruthy();

    fireEvent.click(btn);

    await waitFor(() => {
      expect(mockDeliver).toHaveBeenCalledWith('p1');
    });

    // 刷新后显示已交付记录（时间 / 人 / commit 短哈希），按钮禁用
    await waitFor(() => {
      expect(screen.getByText(/已交付: /)).toBeTruthy();
    });
    expect(screen.getByText(/tester@example\.com/)).toBeTruthy();
    // toast 与台账都含短哈希，断言至少一处出现
    expect(screen.getAllByText(/abcdef1/).length).toBeGreaterThan(0);
    const doneBtn = screen.getByRole('button', { name: '已交付' }) as HTMLButtonElement;
    expect(doneBtn.disabled).toBe(true);
  });

  it('auto-merge：409 时展示 missing / conflictFiles', async () => {
    mockGetDelivery.mockResolvedValue({ data: { ...deliveryAutoMergePending, deliverable: true, missing: [] } });
    mockDeliver.mockRejectedValue({
      response: {
        status: 409,
        data: {
          error: {
            code: 'EVIDENCE_MISSING',
            message: '证据不齐，拒绝合并',
            missing: ['WU-3 缺 L1 自动验证'],
            conflictFiles: ['src/a.ts'],
          },
        },
      },
    });
    renderDetail();

    fireEvent.click(await screen.findByText('交付合并'));

    await waitFor(() => {
      expect(screen.getByText('证据不齐，拒绝合并')).toBeTruthy();
    });
    expect(screen.getByText('WU-3 缺 L1 自动验证')).toBeTruthy();
    expect(screen.getByText(/src\/a\.ts/)).toBeTruthy();
  });

  it('branch-only：不显示交付按钮，显示自行合并说明', async () => {
    mockGetDelivery.mockResolvedValue({ data: deliveryBranchOnly });
    renderDetail();

    await waitFor(() => {
      expect(screen.getByText(/分支交付模式：证据齐后请自行合并分支 PMO-11 并走下游发布链路/)).toBeTruthy();
    });
    expect(screen.queryByText('交付合并')).toBeNull();
    expect(screen.getByText('交付策略: 分支交付')).toBeTruthy();
  });
});
