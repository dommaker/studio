// PMO-b/F6-c: ProjectDetailPage 交付区块测试
// （台账渲染 / 四态徽标 / 缺口行动清单 / auto-merge 交付按钮 / branch-only 提示 / 进展卡口径）
// #149（2026-08-15）：归档知识按钮测试随 document-store 退役移除
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const {
  mockApiGet,
  mockApiPost,
  mockGetProject,
  mockGetDelivery,
  mockDeliver,
  mockVerify,
  mockDispatchReview,
  mockReviewPassed,
} = vi.hoisted(() => ({
  mockApiGet: vi.fn(),
  mockApiPost: vi.fn(),
  mockGetProject: vi.fn(),
  mockGetDelivery: vi.fn(),
  mockDeliver: vi.fn(),
  mockVerify: vi.fn(),
  mockDispatchReview: vi.fn(),
  mockReviewPassed: vi.fn(),
}));

vi.mock('../../api', () => ({
  api: {
    get: mockApiGet,
    post: mockApiPost,
  },
  projectApi: {
    get: mockGetProject,
    getDelivery: mockGetDelivery,
    deliver: mockDeliver,
  },
}));

vi.mock('../../api/workunit', () => ({
  workunitApi: {
    verify: mockVerify,
    dispatchReview: mockDispatchReview,
    reviewPassed: mockReviewPassed,
    // #114：下一个该干什么 / 决策单状态（默认空）
    list: vi.fn().mockResolvedValue({ data: { data: [], total: 0 } }),
    get: vi.fn().mockRejectedValue(new Error('not found')),
  },
}));

import { ProjectDetailPage } from '../ProjectDetailPage';
import { toast } from '../../utils/toast';

const mockProject = {
  id: 'p1',
  pmoNumber: 'PMO-11',
  title: '证据链看板',
  status: 'active',
  priority: 'high',
  progress: 60,
  createdAt: '2026-01-01',
};

// 台账 fixture：auto-merge / 在途 1 个 / WU-3 缺 L2（新契约：tokens/gaps/wu.byStatus）
const deliveryAutoMergePending = {
  projectId: 'p1',
  pmoNumber: 'PMO-11',
  branch: 'PMO-11',
  policy: 'auto-merge' as const,
  gitRepo: '/root/projects/studio',
  wu: {
    total: 3,
    finished: 2,
    inFlight: 1,
    byStatus: { unassigned: 0, active: 1, inReview: 0, blocked: 0 },
  },
  evidence: {
    l1Missing: [] as string[],
    l2Missing: ['WU-3'],
    l3Missing: [] as string[],
    selfReviewCount: 2,
  },
  deliverable: false,
  missing: ['WU-3 缺 L2 agent 评审'],
  tokens: 1234,
  archived: false,
  gaps: [
    { id: 'wu-3', title: '实现交付台账', type: 'task', missing: ['l2'] as Array<'l1' | 'l2' | 'l3'> },
  ],
  deliveredAt: null as string | null,
  deliveredBy: null as string | null,
  deliverCommit: null as string | null,
};

// 台账 fixture：可交付（缺口清空）
const deliveryDeliverable = {
  ...deliveryAutoMergePending,
  deliverable: true,
  missing: [] as string[],
  gaps: [] as typeof deliveryAutoMergePending.gaps,
  evidence: { l1Missing: [], l2Missing: [], l3Missing: [], selfReviewCount: 3 },
};

// 台账 fixture：已交付
const deliveryDelivered = {
  ...deliveryDeliverable,
  deliveredAt: '2026-07-29T10:00:00Z',
  deliveredBy: 'tester@example.com',
  deliverCommit: 'abcdef1234567890',
};

// 台账 fixture：branch-only（可交付，未交付）
const deliveryBranchOnly = {
  ...deliveryDeliverable,
  policy: 'branch-only' as const,
};

describe('PMO-b/F6-c: 交付区块', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    toast.dismiss();
    mockGetProject.mockResolvedValue({ data: mockProject });
    mockApiGet.mockImplementation((url: string) => {
      if (url.includes('/tasks')) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
    mockApiPost.mockResolvedValue({ data: {} });
    mockDeliver.mockResolvedValue({ data: { delivered: true, deliverCommit: 'abcdef1234567890' } });
    mockVerify.mockResolvedValue({ data: { verified: true, report: { commands: ['pnpm test'] } } });
    mockDispatchReview.mockResolvedValue({ data: { reviewWorkUnitId: 'rw-1' } });
    mockReviewPassed.mockResolvedValue({ data: {} });
  });

  const renderDetail = () =>
    render(
      <MemoryRouter initialEntries={['/pmo/project/p1']}>
        <Routes>
          <Route path="/pmo/project/:projectId" element={<ProjectDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

  it('渲染台账：策略/分支/WU 完成度/证据三层 + 在途徽标与缺口行动行', async () => {
    mockGetDelivery.mockResolvedValue({ data: deliveryAutoMergePending });
    renderDetail();

    await waitFor(() => {
      expect(screen.getByText('📦 交付')).toBeTruthy();
    });

    // inFlight>0 → 蓝色进行中徽标
    expect(screen.getByText('🔄 进行中 2/3')).toBeTruthy();
    expect(screen.getByText(/自动合并/)).toBeTruthy();
    expect(screen.getByText(/分支: PMO-11/)).toBeTruthy();
    // #399 §8.3 词表：WU→任务；证据三级白话（自动验证/Agent 评审/人工确认）
    expect(screen.getByText('任务: 2/3 完成')).toBeTruthy();
    expect(screen.getByText('自动验证: ✓')).toBeTruthy();
    expect(screen.getByText('Agent 评审: 缺 1')).toBeTruthy();
    expect(screen.getByText('人工确认: ✓')).toBeTruthy();
    expect(screen.getByText('自评: 2')).toBeTruthy();
    // 缺口行动清单：在途提示 + 任务行（标题/type/缺层白话文案/行动按钮）
    expect(screen.getByText('1 个任务仍在途')).toBeTruthy();
    expect(screen.getByText('实现交付台账')).toBeTruthy();
    expect(screen.getByText('缺 Agent 评审')).toBeTruthy();
    expect(screen.getByRole('button', { name: '派发评审' })).toBeTruthy();
  });

  it('auto-merge：点击交付合并调 deliver，成功后显示已交付记录并禁用按钮', async () => {
    mockGetDelivery
      .mockResolvedValueOnce({ data: deliveryDeliverable })
      .mockResolvedValue({ data: deliveryDelivered });
    renderDetail();

    const btn = await screen.findByText('交付合并');
    expect(screen.getByText('✓ 可交付')).toBeTruthy();

    fireEvent.click(btn);

    await waitFor(() => {
      expect(mockDeliver).toHaveBeenCalledWith('p1');
    });

    // 刷新后显示已交付徽标与记录（时间 / 人 / commit 短哈希），按钮禁用
    await waitFor(() => {
      expect(screen.getByText(/已交付: /)).toBeTruthy();
    });
    expect(screen.getByText('✓ 已交付')).toBeTruthy();
    expect(screen.getByText(/tester@example\.com/)).toBeTruthy();
    // toast 与台账都含短哈希，断言至少一处出现
    expect(screen.getAllByText(/abcdef1/).length).toBeGreaterThan(0);
    const doneBtn = screen.getByRole('button', { name: '已交付' }) as HTMLButtonElement;
    expect(doneBtn.disabled).toBe(true);
  });

  it('auto-merge：409 时展示 missing / conflictFiles', async () => {
    mockGetDelivery.mockResolvedValue({ data: deliveryDeliverable });
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

  it('branch-only：deliverable 且未交付时显示合并提示，无交付按钮', async () => {
    mockGetDelivery.mockResolvedValue({ data: deliveryBranchOnly });
    renderDetail();

    await waitFor(() => {
      expect(screen.getByText(/证据已齐:请合并分支 PMO-11 并走下游发布链路/)).toBeTruthy();
    });
    expect(screen.queryByText('交付合并')).toBeNull();
    expect(screen.getByText('交付策略: 分支交付')).toBeTruthy();
  });

  it('branch-only：证据未齐时不显示合并提示（缺口行动清单即指引）', async () => {
    mockGetDelivery.mockResolvedValue({
      data: { ...deliveryAutoMergePending, policy: 'branch-only' as const },
    });
    renderDetail();

    await waitFor(() => {
      expect(screen.getByText('📦 交付')).toBeTruthy();
    });
    expect(screen.queryByText(/证据已齐:请合并分支/)).toBeNull();
    expect(screen.queryByText('交付合并')).toBeNull();
    expect(screen.getByRole('button', { name: '派发评审' })).toBeTruthy();
  });

  it('待验收徽标 + gap 行渲染 + 点「人工确认」调 reviewPassed 并刷新台账', async () => {
    mockGetDelivery.mockResolvedValue({
      data: {
        ...deliveryAutoMergePending,
        wu: { total: 2, finished: 2, inFlight: 0, byStatus: { unassigned: 0, active: 0, inReview: 0, blocked: 0 } },
        evidence: { l1Missing: [], l2Missing: [], l3Missing: ['wu-9'], selfReviewCount: 1 },
        missing: ['撰写发布说明 缺 L3 人工确认'],
        gaps: [{ id: 'wu-9', title: '撰写发布说明', type: 'doc', missing: ['l3'] as Array<'l1' | 'l2' | 'l3'> }],
      },
    });
    renderDetail();

    // 全部完成但有缺口 → 琥珀待验收徽标
    await waitFor(() => {
      expect(screen.getByText('⏳ 待验收:证据还差 1 项')).toBeTruthy();
    });
    expect(screen.getByText('撰写发布说明')).toBeTruthy();
    expect(screen.getByText('缺人工确认')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '人工确认' }));

    await waitFor(() => {
      expect(mockReviewPassed).toHaveBeenCalledWith('wu-9', undefined, undefined);
    });
    // toast + 刷新（初次加载 1 次 + 行动后 refreshDelivery 再拉 1 次）
    await screen.findByText('人工确认已补齐');
    await waitFor(() => {
      expect(mockGetDelivery.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('「重跑验证」成功：toast 提示 + verify 调用参数 + 刷新台账', async () => {
    mockGetDelivery.mockResolvedValue({
      data: {
        ...deliveryAutoMergePending,
        wu: { total: 1, finished: 1, inFlight: 0, byStatus: { unassigned: 0, active: 0, inReview: 0, blocked: 0 } },
        evidence: { l1Missing: ['wu-1'], l2Missing: [], l3Missing: [], selfReviewCount: 0 },
        missing: ['修复登录缺陷 缺 L1 自动验证'],
        gaps: [{ id: 'wu-1', title: '修复登录缺陷', type: 'bug', missing: ['l1'] as Array<'l1' | 'l2' | 'l3'> }],
      },
    });
    renderDetail();

    fireEvent.click(await screen.findByRole('button', { name: '重跑验证' }));

    await waitFor(() => {
      expect(mockVerify).toHaveBeenCalledWith('wu-1');
    });
    await screen.findByText('验证通过，自动验证已补齐');
    await waitFor(() => {
      expect(mockGetDelivery.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('status=completed 且证据未齐：进展卡内显示琥珀警告条（白话词表，缺 0 的层不显示）', async () => {
    mockGetProject.mockResolvedValue({ data: { ...mockProject, status: 'completed' } });
    mockGetDelivery.mockResolvedValue({
      data: {
        ...deliveryAutoMergePending,
        wu: { total: 2, finished: 2, inFlight: 0, byStatus: { unassigned: 0, active: 0, inReview: 0, blocked: 0 } },
        evidence: { l1Missing: ['wu-1', 'wu-2'], l2Missing: [], l3Missing: ['wu-2'], selfReviewCount: 0 },
        gaps: [
          { id: 'wu-1', title: '甲', type: 'task', missing: ['l1'] as Array<'l1' | 'l2' | 'l3'> },
          { id: 'wu-2', title: '乙', type: 'task', missing: ['l1', 'l3'] as Array<'l1' | 'l2' | 'l3'> },
        ],
      },
    });
    renderDetail();

    await waitFor(() => {
      expect(
        screen.getByText(
          (_, el) =>
            el?.tagName === 'DIV' &&
            el.textContent ===
              '⚠️ 项目已标记完成，但交付证据未齐（2 个任务缺自动验证 · 1 个缺人工确认）——在上方交付卡补齐后才算真正交付',
        ),
      ).toBeTruthy();
    });
  });

  it('#399 §8.2：六卡删除，进展卡 = progress + 已完成 n/m + Token meta（全周期累计）+ 口径副标题', async () => {
    mockGetDelivery.mockResolvedValue({
      data: {
        ...deliveryAutoMergePending,
        wu: {
          total: 8,
          finished: 4,
          inFlight: 2,
          byStatus: { unassigned: 2, active: 1, inReview: 1, blocked: 1 },
        },
        tokens: 1234567,
      },
    });
    renderDetail();

    await waitFor(() => {
      expect(screen.getByText('📈 项目进展')).toBeTruthy();
    });

    // 六卡已删（状态计数唯一表达 = 泳道头）
    expect(screen.queryByText('✅ 完成')).toBeNull();
    expect(screen.queryByText('👀 待验收')).toBeNull();
    expect(screen.queryByText('🚫 阻塞')).toBeNull();
    expect(screen.queryByText('💰 Token')).toBeNull();

    // 新构成：% 走 --fs-stat + mono；同行 n/m 与 Token meta（全周期累计）；--fs-xs muted 副标题
    const pct = screen.getByText(`${mockProject.progress}%`);
    expect(pct.style.fontSize).toBe('var(--fs-stat)');
    expect(pct.className).toContain('font-mono');
    expect(screen.getByText(/已完成 4\/8/)).toBeTruthy();
    expect(screen.getByText(/1\.2M tokens（全周期累计）/)).toBeTruthy();
    expect(screen.getByText('完成数 = 已交付的任务，验收中的不计入')).toBeTruthy();
  });
});
