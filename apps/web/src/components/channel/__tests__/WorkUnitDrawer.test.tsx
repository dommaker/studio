// WorkUnitDrawer — 右抽屉 smoke test：WU 详情（真实 token 事件 + 全局开销红线）/ REQ 全链路
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

const { mockWuGet, mockListTokenEvents, mockListExecSteps, mockReviewPassed, mockReviewRejected, mockGetChain, mockGetOverhead, mockStreamChunks, mockResume, mockClose, mockChannelGet, mockGetAgentSummary, mockGetAgentInstance, mockListAllAgents, mockOnEvent } = vi.hoisted(() => ({
  mockWuGet: vi.fn(),
  mockListTokenEvents: vi.fn(),
  mockListExecSteps: vi.fn(),
  mockReviewPassed: vi.fn(),
  mockReviewRejected: vi.fn(),
  mockGetChain: vi.fn(),
  mockGetOverhead: vi.fn(),
  mockStreamChunks: vi.fn(),
  mockResume: vi.fn(),
  mockClose: vi.fn(),
  mockChannelGet: vi.fn(),
  mockGetAgentSummary: vi.fn(),
  mockGetAgentInstance: vi.fn(),
  mockListAllAgents: vi.fn(),
  mockOnEvent: vi.fn(),
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
      reviewRejected: mockReviewRejected,
      resume: mockResume,
      close: mockClose,
    },
  };
});

vi.mock('../../../api/requirements', () => ({
  requirementApi: { getChain: mockGetChain },
}));

vi.mock('../../../api/monitoring', () => ({
  monitoringApi: {
    getOverhead: mockGetOverhead,
    // #290（清单 #24）：负责人解析（AssigneeLabel → useAssigneeDisplay）
    getAgentSummary: mockGetAgentSummary,
    getAgentInstance: mockGetAgentInstance,
  },
}));

// #275（#251 断点2）：WU 抽屉「#频道名」回频道入口——频道名取自 channelApi.get
vi.mock('../../../api/channel', async () => {
  const actual = await vi.importActual('../../../api/channel');
  return {
    ...actual,
    channelApi: {
      ...(actual as { channelApi: object }).channelApi,
      get: mockChannelGet,
      listAllAgents: mockListAllAgents,
      // #346：rosterStore.ensureFresh 会拉 channelApi.list——必须 stub 掉，
      // 否则真实 axios 请求跨测悬挂落地，把 TTL 锚点打进下一测（store 化前无此调用）
      list: vi.fn().mockRejectedValue(new Error('not mocked here')),
    },
  };
});

// SSE context — 抽屉直接订阅 workunit.status_changed / workunit.tokens（决策 8），用例手工驱动事件；
// onReconnect 置空（#318 后内嵌 ExecutionSteps 经此注册重连对齐）
vi.mock('../../../api/websocketHooks', () => ({
  useWebSocketContext: () => ({ onEvent: mockOnEvent, onReconnect: () => () => {} }),
}));

// Layer B 步内流式 hook — 由用例控制返回的实时 chunk
vi.mock('../../../hooks/useWorkUnitStreamEvents', () => ({
  useWorkUnitStreamEvents: () => mockStreamChunks(),
}));

import { WorkUnitDrawer } from '../WorkUnitDrawer';
import type { DrawerState } from '../WorkUnitDrawer';
import { useRosterStore } from '../../../stores/rosterStore';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// 决策 8：SSE 事件捕获（mockOnEvent 注册的回调，用例手工驱动）。
// #318 起内嵌 ExecutionSteps 也经 onEvent 订阅 → 多订阅者广播，不再是单一 handler 覆盖
let sseHandlers: Array<(msg: { event_type: string; data?: unknown }) => void> = [];
const sseHandler = (msg: { event_type: string; data?: unknown }) => sseHandlers.forEach(h => h(msg));

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

const renderDrawer = (drawer: DrawerState, extra: { onClose?: () => void; onOpenWu?: (id: string) => void; onOpenReq?: (id: string) => void } = {}) =>
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route
          path="/"
          element={
            <WorkUnitDrawer
              drawer={drawer}
              onClose={extra.onClose ?? vi.fn()}
              onOpenWu={extra.onOpenWu ?? vi.fn()}
              onOpenReq={extra.onOpenReq ?? vi.fn()}
            />
          }
        />
        {/* #275 断点2 断言落点：抽屉内点频道链接跳频道页（页面级跳转走 react-router） */}
        <Route path="/channels/:id" element={<div>频道页</div>} />
      </Routes>
    </MemoryRouter>,
  );

describe('WorkUnitDrawer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // #346：负责人解析面读 rosterStore（模块级单例），每测重置避免 TTL 缓存跨测串味
    useRosterStore.setState({
      profiles: [], agents: [], channels: [],
      loading: false, error: null, forbidden: false,
      loadedAt: null, channelsLoadedOnce: false, agentsLoadedOnce: false,
      inflight: null, lastToken: null,
    });
    sseHandlers = [];
    mockOnEvent.mockImplementation((h: (msg: { event_type: string; data?: unknown }) => void) => {
      sseHandlers.push(h);
      return () => { sseHandlers = sseHandlers.filter(x => x !== h); };
    });
    mockWuGet.mockResolvedValue({ data: WU });
    mockListTokenEvents.mockResolvedValue({ data: { events: TOKEN_EVENTS, total: TOKEN_EVENTS.length } });
    mockListExecSteps.mockResolvedValue({ data: { events: [], total: 0 } });
    mockReviewPassed.mockResolvedValue({ data: { ...WU, status: 'done' } });
    mockReviewRejected.mockResolvedValue({ data: { ...WU, status: 'active' } });
    mockResume.mockResolvedValue({ data: { ...WU, status: 'active' } });
    mockClose.mockResolvedValue({ data: { ...WU, status: 'closed' } });
    mockGetOverhead.mockResolvedValue({ data: OVERHEAD });
    mockGetChain.mockResolvedValue({ data: { data: CHAIN } });
    mockStreamChunks.mockReturnValue([]);
    mockChannelGet.mockResolvedValue({ data: { data: { id: 'ch-1', name: '研发', type: 'dev' } } });
    // #290（清单 #24）：负责人解析默认「查无」——摘要空、实例档案 404、profile 列表空
    mockGetAgentSummary.mockResolvedValue({
      data: { agents: [], summary: { total: 0, idle: 0, active: 0, error: 0, terminated: 0 } },
    });
    mockGetAgentInstance.mockRejectedValue(new Error('404'));
    mockListAllAgents.mockResolvedValue({ data: { data: [] } });
  });

  it('renders nothing when drawer is null', () => {
    const { container } = renderDrawer(null);
    expect(container.firstChild).toBeNull();
  });

  // #395（spec §4.6）：<768 抽屉全屏化的左上返回（≥768 由 CSS 隐藏，DOM 常驻）；点击 = 关抽屉
  it('头部「← 返回」按钮：渲染且点击调 onClose', async () => {
    const onClose = vi.fn();
    renderDrawer({ kind: 'wu', id: 'WU-1017' }, { onClose });
    const back = screen.getByRole('button', { name: '返回' });
    expect(back.className).toContain('mc-drawer-back');
    fireEvent.click(back);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows WorkUnit detail with status, owner, REQ link and step count', async () => {
    renderDrawer({ kind: 'wu', id: 'WU-1017' });
    await waitFor(() => expect(screen.getByText('方向稿 A/B 原型页搭建')).toBeTruthy());
    expect(screen.getAllByText('执行中').length).toBeGreaterThan(0); // #182：状态 chip 与速览节各出现一次
    expect(screen.getByText('@coder-1')).toBeTruthy();
    expect(screen.getByText('REQ-0042 ›')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy(); // stepCount
  });

  // #290（清单 #24）：负责人行三级解析口径（与 WU 详情页同一 hook）
  it('#290 负责人解析到角色名：显示 @角色名 并链到 /agents/:roleId', async () => {
    mockGetAgentSummary.mockResolvedValue({
      data: {
        agents: [{ id: 'coder-1', roleId: 'role-coder', name: 'Coder', status: 'idle', currentWorkUnitId: null, startedAt: '2026-07-19T08:00:00Z' }],
        summary: { total: 1, idle: 1, active: 0, error: 0, terminated: 0 },
      },
    });
    renderDrawer({ kind: 'wu', id: 'WU-1017' });
    const link = await screen.findByText('@Coder');
    expect(link.closest('a')?.getAttribute('href')).toBe('/agents/role-coder');
    expect(screen.queryByText('@coder-1')).toBeNull();
  });

  it('#290 负责人为离线实例：经实例档案 roleId + profile 名回退解析', async () => {
    mockGetAgentInstance.mockResolvedValue({ data: { id: 'coder-1', roleId: 'role-coder', status: 'terminated' } });
    mockListAllAgents.mockResolvedValue({ data: { data: [{ id: 'role-coder', name: 'Coder' }] } });
    renderDrawer({ kind: 'wu', id: 'WU-1017' });
    const link = await screen.findByText('@Coder');
    expect(link.closest('a')?.getAttribute('href')).toBe('/agents/role-coder');
  });

  it('#290 负责人查无对应角色：回退短 UUID 且不可点', async () => {
    renderDrawer({ kind: 'wu', id: 'WU-1017' });
    const chip = await screen.findByText('@coder-1'); // 'coder-1' 截 8 位仍为其本身
    await waitFor(() => expect(mockGetAgentInstance).toHaveBeenCalled());
    expect(chip.closest('a')).toBeNull();
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
    expect(screen.getByText('任务链路（2）')).toBeTruthy();
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

  // #275（#251 断点2）：WU 抽屉补「#频道名」回频道入口——反向链路（WU→频道）在抽屉侧补齐
  it('#275：WU 有 channelId → 显示「#频道名」回频道链接，点击页面级跳频道页', async () => {
    renderDrawer({ kind: 'wu', id: 'WU-1017' });
    const link = await screen.findByRole('button', { name: '#研发' });
    expect(mockChannelGet).toHaveBeenCalledWith('ch-1');
    fireEvent.click(link);
    await screen.findByText('频道页');
  });

  it('#275：频道名拉取失败 → 退回 channelId 截短显示（链接仍可跳）', async () => {
    mockChannelGet.mockRejectedValue(new Error('404'));
    renderDrawer({ kind: 'wu', id: 'WU-1017' });
    const link = await screen.findByRole('button', { name: /#ch-1/ });
    fireEvent.click(link);
    await screen.findByText('频道页');
  });

  it('#275：WU 无 channelId → 不渲染频道链接', async () => {
    mockWuGet.mockResolvedValue({ data: { ...WU, channelId: null } });
    renderDrawer({ kind: 'wu', id: 'WU-1017' });
    await waitFor(() => expect(screen.getByText('方向稿 A/B 原型页搭建')).toBeTruthy());
    expect(screen.queryByText('所属频道')).toBeNull();
    expect(mockChannelGet).not.toHaveBeenCalled();
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
    expect(screen.queryByText(/人工确认（留痕）/)).toBeNull();
  });

  it('证据台账：done 缺 l3 → 三层留痕 + 人工确认按钮（点击调 reviewPassed）', async () => {
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
    const btn = screen.getByText('人工确认（留痕）');
    fireEvent.click(btn);
    await waitFor(() => expect(mockReviewPassed).toHaveBeenCalledWith('WU-1017', undefined, undefined));
  });

  it('证据台账：in_review → 审查闸门「通过」按钮（硬门语义）', async () => {
    mockWuGet.mockResolvedValue({ data: { ...WU, status: 'in_review' } });
    renderDrawer({ kind: 'wu', id: 'WU-1017' });
    await waitFor(() => expect(screen.getByText('通过（审查闸门）')).toBeTruthy());
    fireEvent.click(screen.getByText('通过（审查闸门）'));
    await waitFor(() => expect(mockReviewPassed).toHaveBeenCalledWith('WU-1017', undefined, undefined));
  });

  it('analysis 单（#106 M7）：通过走共享确认弹窗——预填清单人改后 summary 随 reviewPassed 回传', async () => {
    mockWuGet.mockResolvedValue({
      data: {
        ...WU,
        type: 'analysis',
        status: 'in_review',
        metadata: JSON.stringify({
          analysisDestination: '三仓特性联动上线',
          analysisFog: ['存储选型用哪个？'],
        }),
      },
    });
    renderDrawer({ kind: 'wu', id: 'WU-1017' });
    await waitFor(() => expect(screen.getByText('通过（审查闸门）')).toBeTruthy());
    fireEvent.click(screen.getByText('通过（审查闸门）'));

    const textarea = await screen.findByPlaceholderText(/目标/) as HTMLTextAreaElement;
    expect(textarea.value).toBe('目标：三仓特性联动上线\n待决：存储选型用哪个？');
    expect(mockReviewPassed).not.toHaveBeenCalled();

    fireEvent.change(textarea, { target: { value: '待决：存储选型用哪个？' } });
    fireEvent.click(screen.getByText('确认通过'));
    await waitFor(() => expect(mockReviewPassed).toHaveBeenCalledWith('WU-1017', '待决：存储选型用哪个？', undefined));
  });

  it('#284：in_review → 拒绝入口（带原因弹窗，调 reviewRejected），与列表行行为一致', async () => {
    mockWuGet.mockResolvedValue({ data: { ...WU, status: 'in_review' } });
    renderDrawer({ kind: 'wu', id: 'WU-1017' });
    fireEvent.click(await screen.findByText('拒绝'));
    fireEvent.change(screen.getByPlaceholderText(/拒绝原因/), { target: { value: '结论不完整，返工' } });
    fireEvent.click(screen.getByText('确认拒绝'));
    await waitFor(() => expect(mockReviewRejected).toHaveBeenCalledWith('WU-1017', '结论不完整，返工'));
  });

  it('#284（决策 #250 D6）：autoApprove「打开即弹」——analysis in_review 抽屉自动弹确认弹窗，无需点通过', async () => {
    mockWuGet.mockResolvedValue({
      data: {
        ...WU,
        type: 'analysis',
        status: 'in_review',
        metadata: JSON.stringify({ analysisDestination: '三仓特性联动上线', analysisFog: ['存储选型用哪个？'] }),
      },
    });
    renderDrawer({ kind: 'wu', id: 'WU-1017', autoApprove: true });
    const textarea = await screen.findByPlaceholderText(/目标/) as HTMLTextAreaElement;
    // 预填逻辑（buildMapOpeningPrefill）不变
    expect(textarea.value).toBe('目标：三仓特性联动上线\n待决：存储选型用哪个？');
    expect(mockReviewPassed).not.toHaveBeenCalled();
  });

  it('#284：autoApprove 但 WU 非 analysis/非 in_review → 不自动弹窗（仅打开抽屉）', async () => {
    mockWuGet.mockResolvedValue({ data: { ...WU, status: 'in_review' } }); // type=dev
    renderDrawer({ kind: 'wu', id: 'WU-1017', autoApprove: true });
    await waitFor(() => expect(screen.getByText('通过（审查闸门）')).toBeTruthy());
    expect(screen.queryByPlaceholderText(/目标/)).toBeNull();
  });

  it('Layer B 实时区块：渲染执行中 chunk（思考/工具/result），step-start 不渲染', async () => {
    mockStreamChunks.mockReturnValue([
      { workUnitId: 'WU-1017', executionId: 'e1', step: 8, kind: 'step-start', at: 't0' },
      { workUnitId: 'WU-1017', executionId: 'e1', step: 8, kind: 'thinking', text: '先看现有实现', at: 't1' },
      { workUnitId: 'WU-1017', executionId: 'e1', step: 8, kind: 'tool', tool: 'Read', summary: '/a/workunit.service.ts', at: 't2' },
      { workUnitId: 'WU-1017', executionId: 'e1', step: 8, kind: 'result', text: '', at: 't3' },
    ]);
    renderDrawer({ kind: 'wu', id: 'WU-1017' });
    await waitFor(() => expect(screen.getByText('第 8 步进行中')).toBeTruthy());
    expect(screen.getByText('实时')).toBeTruthy();
    expect(screen.getByText('思考：先看现有实现')).toBeTruthy();
    expect(screen.getByText(/Read\s+\/a\/workunit\.service\.ts/)).toBeTruthy();
    expect(screen.getByText(/✓ 回合结束/)).toBeTruthy();
    // 实时区存在时不显示「暂无执行过程记录」空态
    expect(screen.queryByText(/暂无执行过程记录/)).toBeNull();
  });

  it('实时区块让位：REST 步级卡片覆盖同 step 后该 step 的实时 chunk 不再展示', async () => {
    mockStreamChunks.mockReturnValue([
      { workUnitId: 'WU-1017', executionId: 'e1', step: 1, kind: 'thinking', text: '已归档的思考', at: 't1' },
      { workUnitId: 'WU-1017', executionId: 'e2', step: 2, kind: 'thinking', text: '进行中的思考', at: 't2' },
    ]);
    mockListExecSteps.mockResolvedValue({
      data: {
        events: [
          { payload: JSON.stringify({ workUnitId: 'WU-1017', executionId: 'e1', step: 1, action: 'progress', thinking: ['已归档的思考'], toolCalls: [], skills: [], at: '2026-07-19T09:35:00Z' }), createdAt: '2026-07-19T09:35:00Z' },
        ],
        total: 1,
      },
    });
    renderDrawer({ kind: 'wu', id: 'WU-1017' });
    await waitFor(() => expect(screen.getByText('#1 · progress')).toBeTruthy());
    // step 1 已被 REST 卡片覆盖 → 实时区只剩 step 2
    expect(screen.getByText('第 2 步进行中')).toBeTruthy();
    const archived = screen.getAllByText('思考：已归档的思考');
    expect(archived).toHaveLength(1); // 只有步级卡片里那一份（实时区不重复展示）
    expect(screen.getByText('思考：进行中的思考')).toBeTruthy();
  });

  it('#185（决策 #87 D4）：blocked 卡住型 WU 显示处置组件（继续执行/关闭任务），点继续执行调 resume', async () => {
    mockWuGet.mockResolvedValue({
      data: { ...WU, status: 'blocked', metadata: JSON.stringify({ title: '方向稿 A/B 原型页搭建', blockReason: 'stuck: 连续 3 步无进展' }) },
    });
    renderDrawer({ kind: 'wu', id: 'WU-1017' });
    const resumeBtn = await screen.findByRole('button', { name: '继续执行' });
    expect(screen.getByRole('button', { name: '关闭任务' })).toBeTruthy();
    fireEvent.click(resumeBtn);
    await waitFor(() => expect(mockResume).toHaveBeenCalledWith('WU-1017'));
  });

  it('#185（决策 #87 D3）：blocked NEED_INPUT 型不显示「继续执行」（维持引导回复），仅「关闭任务」', async () => {
    mockWuGet.mockResolvedValue({
      data: { ...WU, status: 'blocked', metadata: JSON.stringify({ title: '方向稿', waitingForInput: true, waitingQuestion: '用 OAuth 吗？' }) },
    });
    renderDrawer({ kind: 'wu', id: 'WU-1017' });
    await screen.findByRole('button', { name: '关闭任务' });
    expect(screen.queryByRole('button', { name: '继续执行' })).toBeNull();
  });

  // #241：悬空 WU 引用容错——历史清理后消息 footer 可能指向已不存在的 WU
  const axiosError = (status: number) =>
    Object.assign(new Error(`Request failed with status code ${status}`), { isAxiosError: true, response: { status } });

  it('#241：WU 详情 404 → 友好文案 + 原始 id，无裸 404 错误', async () => {
    mockWuGet.mockRejectedValue(axiosError(404));
    renderDrawer({ kind: 'wu', id: '160eeee8-aaaa-bbbb-cccc-dddddddddddd' });
    const note = await screen.findByText(/该任务不存在或已被清理/);
    expect(note.textContent).toContain('160eeee8-aaaa-bbbb-cccc-dddddddddddd');
    expect(screen.queryByText(/加载失败/)).toBeNull();
    expect(screen.queryByText(/status code 404/)).toBeNull();
  });

  it('#241：非 404 错误 → 维持原「加载失败」文案（回归）', async () => {
    mockWuGet.mockRejectedValue(axiosError(500));
    renderDrawer({ kind: 'wu', id: 'WU-1017' });
    await waitFor(() => expect(screen.getByText(/加载失败/)).toBeTruthy());
    expect(screen.queryByText(/该任务不存在或已被清理/)).toBeNull();
  });

  // ── 决策 8（2026-08 SSE 负载加深）：抽屉事件化——status_changed/tokens 负载直更，无 eventTick 重拉 ──

  it('决策8：workunit.status_changed 同 id → 负载直接更新详情，不再 REST 重拉', async () => {
    renderDrawer({ kind: 'wu', id: 'WU-1017' });
    await waitFor(() => expect(screen.getByText('方向稿 A/B 原型页搭建')).toBeTruthy());
    expect(mockWuGet).toHaveBeenCalledTimes(1); // 仅开抽屉打底一次
    act(() => sseHandler!({
      event_type: 'workunit.status_changed',
      data: { workunit: { ...WU, status: 'done', completedAt: '2026-07-19T11:00:00Z' } },
    }));
    await waitFor(() => expect(screen.getAllByText('已完成').length).toBeGreaterThan(0));
    expect(mockWuGet).toHaveBeenCalledTimes(1); // 事件不触发重拉
    expect(mockGetOverhead).toHaveBeenCalledTimes(1); // 全局聚合不随事件重拉
  });

  it('决策8：workunit.status_changed 他 id → 详情不更新', async () => {
    renderDrawer({ kind: 'wu', id: 'WU-1017' });
    await waitFor(() => expect(screen.getAllByText('执行中').length).toBeGreaterThan(0));
    act(() => sseHandler!({
      event_type: 'workunit.status_changed',
      data: { workunit: { ...WU, id: 'WU-9999', status: 'done' } },
    }));
    // 仍为 active 展示（「已完成」不出现；执行中 chip 保留）
    expect(screen.queryByText('已完成')).toBeNull();
    expect(screen.getAllByText('执行中').length).toBeGreaterThan(0);
  });

  it('决策8：workunit.tokens 同 id → 三条 bar 聚合即时累加', async () => {
    renderDrawer({ kind: 'wu', id: 'WU-1017' });
    await waitFor(() => expect(screen.getByText('2 次执行', { exact: false })).toBeTruthy());
    act(() => sseHandler!({
      event_type: 'workunit.tokens',
      data: { workUnitId: 'WU-1017', injectedTokens: 1000, executionTokens: 2000, billedTokens: 2000, totalTokens: 3000 },
    }));
    await waitFor(() => expect(screen.getByText('3 次执行', { exact: false })).toBeTruthy());
    expect(screen.getByText('4.0k')).toBeTruthy(); // 注入 3000+1000
    expect(screen.getByText('14.0k')).toBeTruthy(); // 合计 11000+3000
    expect(mockListTokenEvents).toHaveBeenCalledTimes(1); // 历史打底仍只一次
  });

  it('决策8：workunit.tokens 他 id / 缺字段负载 → 聚合保持现有值（防御）', async () => {
    renderDrawer({ kind: 'wu', id: 'WU-1017' });
    await waitFor(() => expect(screen.getByText('2 次执行', { exact: false })).toBeTruthy());
    act(() => sseHandler!({
      event_type: 'workunit.tokens',
      data: { workUnitId: 'WU-9999', injectedTokens: 5000, executionTokens: 5000, totalTokens: 10000 },
    }));
    act(() => sseHandler!({
      event_type: 'workunit.tokens',
      data: { workUnitId: 'WU-1017' }, // 缺 injected/execution/total → 不计入
    }));
    expect(screen.getByText('2 次执行', { exact: false })).toBeTruthy();
    expect(screen.getByText('3.0k')).toBeTruthy();
    expect(screen.getByText('11.0k')).toBeTruthy();
  });
});
