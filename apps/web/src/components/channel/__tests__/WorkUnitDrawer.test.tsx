// WorkUnitDrawer — 右抽屉 smoke test：WU 详情（真实 token 事件 + 全局开销红线）/ REQ 全链路
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { mockWuGet, mockListTokenEvents, mockListExecSteps, mockReviewPassed, mockGetChain, mockGetOverhead } = vi.hoisted(() => ({
  mockWuGet: vi.fn(),
  mockListTokenEvents: vi.fn(),
  mockListExecSteps: vi.fn(),
  mockReviewPassed: vi.fn(),
  mockGetChain: vi.fn(),
  mockGetOverhead: vi.fn(),
}));

vi.mock('../../../api/workunit', async () => {
  const actual = await vi.importActual('../../../api/workunit');
  return {
    ...actual,
    workunitApi: {
      get: mockWuGet,
      listTokenEvents: mockListTokenEvents,
      listExecutionStepEvents: mockListExecSteps,
      reviewPassed: mockReviewPassed,
    },
  };
});

vi.mock('../../../api/requirements', () => ({
  requirementApi: { getChain: mockGetChain },
}));

vi.mock('../../../api/monitoring', () => ({
  monitoringApi: { getOverhead: mockGetOverhead },
}));

// WU 事件 hook（SSE）— 测试无 WebSocketProvider，置空
vi.mock('../../../hooks/useWorkUnitEvents', () => ({
  useWorkUnitEvents: () => {},
}));

import { WorkUnitDrawer } from '../WorkUnitDrawer';

const WU = {
  id: 'WU-1017',
  parentId: null,
  dependsOn: '',
  type: 'dev',
  scope: '方向稿 A/B 原型页搭建',
  assigneeId: 'coder-1',
  status: 'active',
  failureType: null,
  retryCount: 1,
  timeoutAt: null,
  channelId: 'ch-1',
  reqId: 'REQ-0042',
  metadata: JSON.stringify({ stepCount: 7 }),
  createdAt: '2026-07-19T09:00:00Z',
  updatedAt: '2026-07-19T10:00:00Z',
  claimedAt: '2026-07-19T09:01:00Z',
  completedAt: null,
};

const TOKEN_EVENTS = [
  // 本 WU 两条（一条 CLI 未回报 usage），一条其他 WU 应被过滤，一条坏行应被跳过
  { payload: JSON.stringify({ workUnitId: 'WU-1017', injectedTokens: 2000, executionTokens: 8000, totalTokens: 10000 }), createdAt: '2026-07-19T09:30:00Z' },
  { payload: JSON.stringify({ workUnitId: 'WU-1017', injectedTokens: 1000, executionTokens: null, totalTokens: 1000 }), createdAt: '2026-07-19T10:30:00Z' },
  { payload: JSON.stringify({ workUnitId: 'WU-9999', injectedTokens: 999, executionTokens: 1, totalTokens: 1000 }), createdAt: '2026-07-19T10:00:00Z' },
  { payload: '{broken', createdAt: '2026-07-19T10:01:00Z' },
];

const OVERHEAD = {
  windowDays: 30,
  executions: 12,
  workUnits: 8,
  avgInjectedTokens: 1800,
  injectedBudget: 2000,
  injectedBudgetUsedPct: 90,
  avgExecutionTokens: 9000,
  executionCoveragePct: 75,
  avgOverheadRatio: 0.2,
  overheadBudget: 1.2,
  extractionTokens: 500,
  source: 'events' as const,
  timestamp: '2026-07-20T00:00:00Z',
};

const CHAIN = {
  requirement: {
    id: 'REQ-0042', seq: 42, title: '主界面视觉方向稿', status: 'in-progress' as const,
    createdAt: '2026-07-18T15:00:00Z', createdBy: '张弛', docs: ['docs/plans/x.md'],
  },
  workunits: [
    { id: 'WU-1017', title: '方向稿 A/B 原型页搭建', status: 'active', assigneeId: 'coder-1' },
    { id: 'WU-1015', title: 'REQ chips 条落地', status: 'done', assigneeId: 'coder-1' },
  ],
};

const renderDrawer = (drawer: any, extra: any = {}) =>
  render(
    <WorkUnitDrawer
      drawer={drawer}
      onClose={extra.onClose ?? vi.fn()}
      onOpenWu={extra.onOpenWu ?? vi.fn()}
      onOpenReq={extra.onOpenReq ?? vi.fn()}
    />,
  );

describe('WorkUnitDrawer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWuGet.mockResolvedValue({ data: WU });
    mockListTokenEvents.mockResolvedValue({ data: { events: TOKEN_EVENTS, total: TOKEN_EVENTS.length } });
    mockListExecSteps.mockResolvedValue({ data: { events: [], total: 0 } });
    mockReviewPassed.mockResolvedValue({ data: { ...WU, status: 'done' } });
    mockGetOverhead.mockResolvedValue({ data: OVERHEAD });
    mockGetChain.mockResolvedValue({ data: { data: CHAIN } });
  });

  it('renders nothing when drawer is null', () => {
    const { container } = renderDrawer(null);
    expect(container.firstChild).toBeNull();
  });

  it('shows WorkUnit detail with status, owner, REQ link and step count', async () => {
    renderDrawer({ kind: 'wu', id: 'WU-1017' });
    await waitFor(() => expect(screen.getByText('方向稿 A/B 原型页搭建')).toBeTruthy());
    expect(screen.getByText('执行中')).toBeTruthy();
    expect(screen.getByText('@coder-1')).toBeTruthy();
    expect(screen.getByText('REQ-0042 ›')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy(); // stepCount
  });

  it('aggregates only this WorkUnit token events and marks unavailable CLI usage', async () => {
    renderDrawer({ kind: 'wu', id: 'WU-1017' });
    await waitFor(() => expect(screen.getByText('2 次执行', { exact: false })).toBeTruthy());
    // 注入合计 3.0k（2000+1000；WU-9999 被过滤）
    expect(screen.getByText('3.0k')).toBeTruthy();
    // 合计 11.0k（10000+1000）
    expect(screen.getByText('11.0k')).toBeTruthy();
    expect(screen.getByText(/1 次 CLI 未回报 usage/)).toBeTruthy();
  });

  it('shows global overhead redline from monitoring API', async () => {
    renderDrawer({ kind: 'wu', id: 'WU-1017' });
    await waitFor(() => expect(screen.getByText(/封装开销 0\.20x/)).toBeTruthy());
    expect(screen.getByText(/红线 1\.2x/)).toBeTruthy();
    expect(screen.getByText(/预算 2\.0k/)).toBeTruthy();
  });

  it('honestly reports insufficient overhead data instead of fabricating', async () => {
    mockGetOverhead.mockResolvedValue({ data: { ...OVERHEAD, source: 'insufficient-data' } });
    renderDrawer({ kind: 'wu', id: 'WU-1017' });
    await waitFor(() => expect(screen.getByText('窗口内度量数据不足')).toBeTruthy());
    expect(screen.queryByText(/封装开销 0\.20x/)).toBeNull();
  });

  it('shows empty token note when no events for this WorkUnit', async () => {
    mockListTokenEvents.mockResolvedValue({ data: { events: [], total: 0 } });
    renderDrawer({ kind: 'wu', id: 'WU-1017' });
    await waitFor(() => expect(screen.getByText('窗口内无 token 度量事件')).toBeTruthy());
  });

  it('REQ chain renders workunit nodes and forwards click to onOpenWu', async () => {
    const onOpenWu = vi.fn();
    renderDrawer({ kind: 'req', id: 'REQ-0042' }, { onOpenWu });
    await waitFor(() => expect(screen.getByText('主界面视觉方向稿')).toBeTruthy());
    expect(screen.getByText('REQ-0042 全链路')).toBeTruthy();
    expect(screen.getByText('WorkUnit 链路（2）')).toBeTruthy();
    fireEvent.click(screen.getByText('WU-1015').closest('button')!);
    expect(onOpenWu).toHaveBeenCalledWith('WU-1015');
  });

  it('WU detail REQ link forwards to onOpenReq', async () => {
    const onOpenReq = vi.fn();
    renderDrawer({ kind: 'wu', id: 'WU-1017' }, { onOpenReq });
    await waitFor(() => expect(screen.getByText('REQ-0042 ›')).toBeTruthy());
    fireEvent.click(screen.getByText('REQ-0042 ›'));
    expect(onOpenReq).toHaveBeenCalledWith('REQ-0042');
  });

  it('close button invokes onClose', async () => {
    const onClose = vi.fn();
    renderDrawer({ kind: 'wu', id: 'WU-1017' }, { onClose });
    fireEvent.click(screen.getByLabelText('关闭抽屉'));
    expect(onClose).toHaveBeenCalled();
  });

  it('执行过程区块：渲染步事件（思考/工具/skill/用量），按步号升序', async () => {
    mockListExecSteps.mockResolvedValue({
      data: {
        events: [
          // 乱序 + 一条其他 WU + 一条坏行：解析应过滤并排序
          { payload: JSON.stringify({ workUnitId: 'WU-1017', executionId: 'e1', step: 2, action: 'complete', thinking: [], toolCalls: [{ tool: 'Bash', summary: 'pnpm test' }], skills: [], usage: { inputTokens: 100, outputTokens: 50 }, at: '2026-07-19T10:05:00Z' }), createdAt: '2026-07-19T10:05:00Z' },
          { payload: JSON.stringify({ workUnitId: 'WU-9999', executionId: 'e9', step: 1, thinking: ['别的 WU'], toolCalls: [], skills: [], at: '2026-07-19T09:05:00Z' }), createdAt: '2026-07-19T09:05:00Z' },
          { payload: '{broken', createdAt: '2026-07-19T09:06:00Z' },
          { payload: JSON.stringify({ workUnitId: 'WU-1017', executionId: 'e1', step: 1, action: 'progress', thinking: ['先看现有实现'], toolCalls: [{ tool: 'Read', summary: '/a/workunit.service.ts' }], skills: ['tdd-implement'], usage: { inputTokens: 2000, outputTokens: 500 }, at: '2026-07-19T09:35:00Z' }), createdAt: '2026-07-19T09:35:00Z' },
        ],
        total: 4,
      },
    });
    renderDrawer({ kind: 'wu', id: 'WU-1017' });
    await waitFor(() => expect(screen.getByText('思考：先看现有实现')).toBeTruthy());
    expect(screen.getByText(/Read\s+\/a\/workunit\.service\.ts/)).toBeTruthy();
    expect(screen.getByText(/Bash\s+pnpm test/)).toBeTruthy();
    expect(screen.getByText('skills：tdd-implement')).toBeTruthy();
    expect(screen.getByText(/2\.5k tok/)).toBeTruthy();
    expect(screen.queryByText(/别的 WU/)).toBeNull();
    // 步号升序：#1 在 #2 前
    const step1 = screen.getByText('#1 · progress');
    const step2 = screen.getByText('#2 · complete');
    expect(step1.compareDocumentPosition(step2) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('执行过程区块：无事件时显示诚实空态', async () => {
    renderDrawer({ kind: 'wu', id: 'WU-1017' });
    await waitFor(() => expect(screen.getByText(/暂无执行过程记录/)).toBeTruthy());
  });

  it('证据台账：legacy WU（无 attestations）显示未介入说明，无确认按钮', async () => {
    renderDrawer({ kind: 'wu', id: 'WU-1017' });
    await waitFor(() => expect(screen.getByText('证据台账')).toBeTruthy());
    expect(screen.getByText(/证据模型未介入/)).toBeTruthy();
    expect(screen.queryByText(/人工验收确认/)).toBeNull();
  });

  it('证据台账：done 缺 l3 → 三层留痕 + L3 人工验收确认按钮（点击调 reviewPassed）', async () => {
    mockWuGet.mockResolvedValue({
      data: {
        ...WU,
        status: 'done',
        completedAt: '2026-07-19T11:00:00Z',
        metadata: JSON.stringify({
          attestations: {
            l1: { verdict: 'approved', by: 'verify', at: '2026-07-19T10:50:00Z', kind: 'verify' },
            l2: { verdict: 'approved', by: '76d96d35-c35e', at: '2026-07-19T10:55:00Z', kind: 'agent-review', summary: '实现正确' },
          },
        }),
      },
    });
    renderDrawer({ kind: 'wu', id: 'WU-1017' });
    await waitFor(() => expect(screen.getByText(/评审结论：实现正确/)).toBeTruthy());
    expect(screen.getByText(/✓ agent-review · 76d96d3/)).toBeTruthy();
    const btn = screen.getByText('人工验收确认（L3 留痕）');
    fireEvent.click(btn);
    await waitFor(() => expect(mockReviewPassed).toHaveBeenCalledWith('WU-1017'));
  });

  it('证据台账：in_review → 审查闸门「通过」按钮（硬门语义）', async () => {
    mockWuGet.mockResolvedValue({ data: { ...WU, status: 'in_review' } });
    renderDrawer({ kind: 'wu', id: 'WU-1017' });
    await waitFor(() => expect(screen.getByText('通过（审查闸门）')).toBeTruthy());
    fireEvent.click(screen.getByText('通过（审查闸门）'));
    await waitFor(() => expect(mockReviewPassed).toHaveBeenCalledWith('WU-1017'));
  });
});
