// ExecutionSteps - WU 过程可视化组件：执行步事件流 + Layer B 步内实时 chunk
// 从 WorkUnitDrawer 抽取的复用组件，独立验证渲染契约（步事件/空态/实时/让位）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';

const { mockListExecSteps, mockStreamChunks, sse } = vi.hoisted(() => ({
  mockListExecSteps: vi.fn(),
  mockStreamChunks: vi.fn(),
  // SSE 注册口捕获：组件经 useWebSocketContext 订阅后，用例经 sse.handler 注入消息、sse.reconnect 模拟重连
  sse: {
    handler: null as null | ((msg: { event_type: string; data: unknown }) => void),
    reconnect: null as null | (() => void),
  },
}));

vi.mock('../../../api/workunit', async () => {
  const actual = await vi.importActual('../../../api/workunit');
  return {
    ...actual,
    workunitApi: { listExecutionStepEvents: mockListExecSteps },
  };
});

// SSE 上下文 - 测试无 WebSocketProvider，捕获订阅回调供用例注入
vi.mock('../../../api/websocketHooks', () => ({
  useWebSocketContext: () => ({
    onEvent: (fn: (msg: { event_type: string; data: unknown }) => void) => {
      sse.handler = fn;
      return () => { sse.handler = null; };
    },
    onReconnect: (fn: () => void) => {
      sse.reconnect = fn;
      return () => { sse.reconnect = null; };
    },
  }),
}));

// Layer B 步内流式 hook - 由用例控制返回的实时 chunk
vi.mock('../../../hooks/useWorkUnitStreamEvents', () => ({
  useWorkUnitStreamEvents: () => mockStreamChunks(),
}));

import { ExecutionSteps } from '../ExecutionSteps';
import type { WorkUnit } from '../../../api/workunit';

const stepEvent = (step: number, overrides: Record<string, unknown> = {}) => ({
  payload: JSON.stringify({
    workUnitId: 'WU-1',
    executionId: 'e1',
    step,
    action: 'progress',
    thinking: [],
    toolCalls: [],
    skills: [],
    at: '2026-07-19T09:35:00Z',
    ...overrides,
  }),
  createdAt: '2026-07-19T09:35:00Z',
});

describe('ExecutionSteps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListExecSteps.mockResolvedValue({ data: { events: [], total: 0 } });
    mockStreamChunks.mockReturnValue([]);
  });

  it('无事件且无实时 chunk -> 诚实空态', async () => {
    render(<ExecutionSteps workUnitId="WU-1" />);
    await waitFor(() => expect(screen.getByText(/暂无执行过程记录/)).toBeTruthy());
  });

  it('加载中（steps===null）-> 显示加载中；API reject -> 空态不崩', async () => {
    mockListExecSteps.mockRejectedValue(new Error('net'));
    render(<ExecutionSteps workUnitId="WU-1" />);
    await waitFor(() => expect(screen.getByText(/暂无执行过程记录/)).toBeTruthy());
  });

  it('渲染步事件（思考/工具/skill/用量），按步号升序，过滤其他 WU 与坏行', async () => {
    mockListExecSteps.mockResolvedValue({
      data: {
        events: [
          stepEvent(2, { action: 'complete', thinking: [], toolCalls: [{ tool: 'Bash', summary: 'pnpm test' }], skills: [], usage: { inputTokens: 100, outputTokens: 50 }, at: '2026-07-19T10:05:00Z' }),
          { payload: JSON.stringify({ workUnitId: 'WU-9999', executionId: 'e9', step: 1, thinking: ['别的 WU'], toolCalls: [], skills: [], at: '2026-07-19T09:05:00Z' }), createdAt: '2026-07-19T09:05:00Z' },
          { payload: '{broken', createdAt: '2026-07-19T09:06:00Z' },
          stepEvent(1, { action: 'progress', thinking: ['先看现有实现'], toolCalls: [{ tool: 'Read', summary: '/a/workunit.service.ts' }], skills: ['tdd-implement'], usage: { inputTokens: 2000, outputTokens: 500 }, at: '2026-07-19T09:35:00Z' }),
        ],
        total: 4,
      },
    });
    render(<ExecutionSteps workUnitId="WU-1" />);
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

  it('Layer B 实时区块：渲染执行中 chunk（思考/工具/result），step-start 不渲染', async () => {
    mockStreamChunks.mockReturnValue([
      { workUnitId: 'WU-1', executionId: 'e1', step: 8, kind: 'step-start', at: 't0' },
      { workUnitId: 'WU-1', executionId: 'e1', step: 8, kind: 'thinking', text: '先看现有实现', at: 't1' },
      { workUnitId: 'WU-1', executionId: 'e1', step: 8, kind: 'tool', tool: 'Read', summary: '/a/workunit.service.ts', at: 't2' },
      { workUnitId: 'WU-1', executionId: 'e1', step: 8, kind: 'result', text: '', at: 't3' },
    ]);
    render(<ExecutionSteps workUnitId="WU-1" />);
    await waitFor(() => expect(screen.getByText('第 8 步进行中')).toBeTruthy());
    expect(screen.getByText('实时')).toBeTruthy();
    expect(screen.getByText('思考：先看现有实现')).toBeTruthy();
    expect(screen.getByText(/Read\s+\/a\/workunit\.service\.ts/)).toBeTruthy();
    expect(screen.getByText(/✓ 回合结束/)).toBeTruthy();
    // 实时区存在时不显示空态
    expect(screen.queryByText(/暂无执行过程记录/)).toBeNull();
  });

  it('实时区让位：REST 步级卡片覆盖同 step 后该 step 的实时 chunk 不再展示', async () => {
    mockStreamChunks.mockReturnValue([
      { workUnitId: 'WU-1', executionId: 'e1', step: 1, kind: 'thinking', text: '已归档的思考', at: 't1' },
      { workUnitId: 'WU-1', executionId: 'e2', step: 2, kind: 'thinking', text: '进行中的思考', at: 't2' },
    ]);
    mockListExecSteps.mockResolvedValue({
      data: {
        events: [stepEvent(1, { thinking: ['已归档的思考'], toolCalls: [], skills: [], at: '2026-07-19T09:35:00Z' })],
        total: 1,
      },
    });
    render(<ExecutionSteps workUnitId="WU-1" />);
    await waitFor(() => expect(screen.getByText('#1 · progress')).toBeTruthy());
    // step 1 已被 REST 卡片覆盖 -> 实时区只剩 step 2
    expect(screen.getByText('第 2 步进行中')).toBeTruthy();
    const archived = screen.getAllByText('思考：已归档的思考');
    expect(archived).toHaveLength(1); // 只有步级卡片里那一份（实时区不重复展示）
    expect(screen.getByText('思考：进行中的思考')).toBeTruthy();
  });
});

// #240：折叠工具行 + 四态 + 执行级状态条（状态推导本体见 execution-rows.test.ts）
describe('ExecutionSteps — #240 折叠工具行与执行级状态条', () => {
  const live = (chunks: Array<Record<string, unknown>>) =>
    chunks.map(c => ({ workUnitId: 'WU-1', executionId: 'e1', step: 8, at: 't', ...c }));

  beforeEach(() => {
    vi.clearAllMocks();
    mockListExecSteps.mockResolvedValue({ data: { events: [], total: 0 } });
    mockStreamChunks.mockReturnValue([]);
  });

  it('工具行默认折叠；点击整行展开看输出（内部滚动容器），再点收起', async () => {
    mockStreamChunks.mockReturnValue(live([
      { kind: 'tool', tool: 'Bash', summary: 'pnpm test', toolUseId: 'tu1' },
      { kind: 'tool-result', toolUseId: 'tu1', text: 'Tests 22 passed' },
    ]));
    render(<ExecutionSteps workUnitId="WU-1" />);
    const label = await screen.findByText(/Bash pnpm test/);
    // 默认折叠：输出不可见
    expect(screen.queryByText('Tests 22 passed')).toBeNull();
    fireEvent.click(label);
    expect(screen.getByText('Tests 22 passed')).toBeTruthy();
    fireEvent.click(label);
    expect(screen.queryByText('Tests 22 passed')).toBeNull();
  });

  it('四态可区分：running/ok/error/stopped 各有可读标识', async () => {
    mockStreamChunks.mockReturnValue(live([
      { kind: 'tool', tool: 'Bash', summary: 'cmd-a', toolUseId: 'tu1' },
      { kind: 'tool-result', toolUseId: 'tu1', text: 'ok' },
      { kind: 'tool', tool: 'Read', summary: '/a.ts', toolUseId: 'tu2' },
      { kind: 'tool-result', toolUseId: 'tu2', isError: true, text: 'boom' },
      { kind: 'tool', tool: 'Grep', summary: 'foo', toolUseId: 'tu3' },
      { kind: 'result', text: '' }, // 步结束 → tu3 未配对 = stopped
    ]));
    render(<ExecutionSteps workUnitId="WU-1" />);
    await screen.findByText(/Bash cmd-a/);
    expect(screen.getByLabelText('成功')).toBeTruthy();
    expect(screen.getByLabelText('失败')).toBeTruthy();
    expect(screen.getByLabelText('已中断')).toBeTruthy();
    expect(screen.queryByLabelText('运行中')).toBeNull(); // 步已结束，不得永远转圈
  });

  it('步进行中时未配对工具 = running（运行中标识）', async () => {
    mockStreamChunks.mockReturnValue(live([
      { kind: 'tool', tool: 'Bash', summary: 'cmd-a', toolUseId: 'tu1' },
    ]));
    render(<ExecutionSteps workUnitId="WU-1" />);
    await screen.findByText(/Bash cmd-a/);
    expect(screen.getByLabelText('运行中')).toBeTruthy();
  });

  it('执行级状态条跨步不卸载（不闪烁），文案更新到最新步', async () => {
    mockStreamChunks.mockReturnValue(live([{ kind: 'thinking', text: '想' }]));
    const { rerender } = render(<ExecutionSteps workUnitId="WU-1" />);
    const bar = await screen.findByText('实时');
    const barEl = bar.closest('.mc-exec-statusbar');
    expect(barEl).toBeTruthy();
    expect(screen.getByText('第 8 步进行中')).toBeTruthy();
    // 新一步 chunk 到达（同一 execution）：状态条仍是同一 DOM 节点，仅文案更新
    mockStreamChunks.mockReturnValue(
      live([{ kind: 'thinking', text: '想' }]).map(c => ({ ...c, step: 9 })),
    );
    rerender(<ExecutionSteps workUnitId="WU-1" />);
    expect(screen.getByText('第 9 步进行中')).toBeTruthy();
    expect(screen.getByText('实时').closest('.mc-exec-statusbar')).toBe(barEl);
  });

  it('thinking 独立成行（与工具行/正文分开）', async () => {
    mockStreamChunks.mockReturnValue(live([
      { kind: 'thinking', text: '先看现有实现' },
      { kind: 'tool', tool: 'Read', summary: '/a.ts', toolUseId: 'tu1' },
    ]));
    render(<ExecutionSteps workUnitId="WU-1" />);
    const thinking = await screen.findByText('思考：先看现有实现');
    expect(thinking.closest('.mc-exec-thinking')).toBeTruthy();
  });
});

// #182（决策 #61 速览档）：传 wu 时置顶「当前状态速览」节——状态 / 第 N 步·上限 M / 最近进展 / 失败原因 / 累计 token
describe('ExecutionSteps · 当前状态速览（#182）', () => {
  const glanceWu = (overrides: Record<string, unknown> = {}): WorkUnit => ({
    id: 'WU-1',
    parentId: null,
    dependsOn: '',
    type: 'task',
    scope: '范围',
    assigneeId: null,
    status: 'active',
    failureType: null,
    retryCount: 0,
    timeoutAt: null,
    channelId: null,
    metadata: JSON.stringify({ stepCount: 7, progressLog: [{ step: 7, action: 'progress', summary: '修好登录校验', at: '2026-08-16T00:00:00Z' }] }),
    createdAt: '2026-08-16T00:00:00Z',
    updatedAt: '2026-08-16T00:00:00Z',
    claimedAt: null,
    completedAt: null,
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockListExecSteps.mockResolvedValue({ data: { events: [], total: 0 } });
    mockStreamChunks.mockReturnValue([]);
  });

  it('置顶速览节：状态 / 进度 / 最近进展 / 累计 token 四行全在，且在「执行过程」之前', async () => {
    mockListExecSteps.mockResolvedValue({
      data: {
        events: [
          stepEvent(1, { usage: { inputTokens: 2000, outputTokens: 500 } }),
          stepEvent(2, { usage: { inputTokens: 1000, outputTokens: 500 } }),
        ],
        total: 2,
      },
    });
    render(<ExecutionSteps workUnitId="WU-1" wu={glanceWu()} />);
    await waitFor(() => expect(screen.getByText('当前状态')).toBeTruthy());
    expect(screen.getByText('状态')).toBeTruthy();
    expect(screen.getByText('执行中')).toBeTruthy();
    expect(screen.getByText('进度')).toBeTruthy();
    expect(screen.getByText('第 7 步 / 上限 15 步')).toBeTruthy();
    expect(screen.getByText('最近进展')).toBeTruthy();
    expect(screen.getByText(/修好登录校验/)).toBeTruthy();
    // 累计 token = 步事件 usage 合计（2500 + 1500 = 4000 → 4.0k）
    expect(screen.getByText('累计 token')).toBeTruthy();
    expect(screen.getByText('4.0k')).toBeTruthy();
    // 置顶：速览节在「执行过程」标签之前
    const glance = screen.getByText('当前状态');
    const stepsLabel = screen.getByText('执行过程');
    expect(glance.compareDocumentPosition(stepsLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('不传 wu -> 不渲染速览节（WorkUnitListPage 行内展开不受影响）', async () => {
    render(<ExecutionSteps workUnitId="WU-1" />);
    await waitFor(() => expect(screen.getByText(/暂无执行过程记录/)).toBeTruthy());
    expect(screen.queryByText('当前状态')).toBeNull();
  });

  it('步数 ≥80% 上限 -> 平实提示；未达 -> 不提示', async () => {
    const { unmount } = render(
      <ExecutionSteps workUnitId="WU-1" wu={glanceWu({ metadata: JSON.stringify({ stepCount: 12 }) })} />,
    );
    await waitFor(() => expect(screen.getByText(/接近步数上限/)).toBeTruthy());
    unmount();
    render(<ExecutionSteps workUnitId="WU-1" wu={glanceWu()} />);
    await waitFor(() => expect(screen.getByText('当前状态')).toBeTruthy());
    expect(screen.queryByText(/接近步数上限/)).toBeNull();
  });

  it('review WU 上限放宽为 30（对齐 agent-loop REVIEW_STEP_LIMIT）', async () => {
    render(<ExecutionSteps workUnitId="WU-1" wu={glanceWu({ type: 'review' })} />);
    await waitFor(() => expect(screen.getByText('第 7 步 / 上限 30 步')).toBeTruthy());
  });

  it('失败原因来自失败步事件（errorDetail 优先），失败步卡片标 ✗', async () => {
    mockListExecSteps.mockResolvedValue({
      data: {
        events: [
          stepEvent(1, { usage: { inputTokens: 10, outputTokens: 10 } }),
          stepEvent(2, { action: 'failed', status: 'failed', errorType: 'execution_failed', errorDetail: 'Verify FAILED: tsc' }),
        ],
        total: 2,
      },
    });
    render(<ExecutionSteps workUnitId="WU-1" wu={glanceWu({ status: 'blocked', metadata: JSON.stringify({ stepCount: 2 }) })} />);
    await waitFor(() => expect(screen.getByText('失败原因')).toBeTruthy());
    expect(screen.getByText('Verify FAILED: tsc')).toBeTruthy();
    // 失败步卡片头部标 ✗
    expect(screen.getByText('#2 · failed · ✗ 失败')).toBeTruthy();
    expect(screen.getByText('#1 · progress')).toBeTruthy(); // 成功步不标
  });

  it('无失败步事件 -> 不渲染失败原因行', async () => {
    mockListExecSteps.mockResolvedValue({ data: { events: [stepEvent(1)], total: 1 } });
    render(<ExecutionSteps workUnitId="WU-1" wu={glanceWu({ metadata: JSON.stringify({ stepCount: 1 }) })} />);
    await waitFor(() => expect(screen.getByText('当前状态')).toBeTruthy());
    expect(screen.queryByText('失败原因')).toBeNull();
  });
});

// #318：workunit.execution.step SSE 负载直更——步结束事件负载就地 append，替代 eventTick 防抖重拉
describe('ExecutionSteps — SSE 负载直更（#318）', () => {
  // SSE data 与落盘 payload 同形（execution-step-events.ts emitExecutionStepEvent：data = payload 本体）
  const sseStep = (step: number, overrides: Record<string, unknown> = {}) => ({
    event_type: 'workunit.execution.step',
    data: {
      workUnitId: 'WU-1',
      executionId: 'e1',
      step,
      action: 'progress',
      status: 'success',
      thinking: [`步 ${step} 的思考`],
      toolCalls: [],
      skills: [],
      at: `2026-08-24T10:0${step}:00Z`,
      ...overrides,
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sse.handler = null;
    sse.reconnect = null;
    mockListExecSteps.mockResolvedValue({ data: { events: [], total: 0 } });
    mockStreamChunks.mockReturnValue([]);
  });

  it('步事件 SSE 到达 -> 无 REST 重拉即出新步卡片', async () => {
    mockListExecSteps.mockResolvedValue({ data: { events: [stepEvent(1)], total: 1 } });
    render(<ExecutionSteps workUnitId="WU-1" />);
    await waitFor(() => expect(screen.getByText('#1 · progress')).toBeTruthy());
    expect(sse.handler).toBeTruthy();
    act(() => sse.handler!(sseStep(2)));
    await waitFor(() => expect(screen.getByText('#2 · progress')).toBeTruthy());
    expect(screen.getByText('思考：步 2 的思考')).toBeTruthy();
    // 仅首拉一次：负载直更不得触发整组重拉
    expect(mockListExecSteps).toHaveBeenCalledTimes(1);
  });

  it('乱序到达按步号升序渲染；同 step 重发去重（后者覆盖）', async () => {
    render(<ExecutionSteps workUnitId="WU-1" />);
    await waitFor(() => expect(sse.handler).toBeTruthy());
    act(() => sse.handler!(sseStep(3)));
    act(() => sse.handler!(sseStep(2)));
    act(() => sse.handler!(sseStep(3, { thinking: ['步 3 修订思考'] })));
    await waitFor(() => expect(screen.getByText('#3 · progress')).toBeTruthy());
    const step2 = screen.getByText('#2 · progress');
    const step3 = screen.getByText('#3 · progress');
    expect(step2.compareDocumentPosition(step3) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 去重：step 3 只有一张卡片，内容为重发版本
    expect(screen.getAllByText('#3 · progress')).toHaveLength(1);
    expect(screen.getByText('思考：步 3 修订思考')).toBeTruthy();
    expect(screen.queryByText('思考：步 3 的思考')).toBeNull();
    expect(mockListExecSteps).toHaveBeenCalledTimes(1);
  });

  it('其他 WU / 非步事件的 SSE 消息忽略', async () => {
    render(<ExecutionSteps workUnitId="WU-1" />);
    await waitFor(() => expect(sse.handler).toBeTruthy());
    act(() => sse.handler!(sseStep(5, { workUnitId: 'WU-9999' })));
    act(() => sse.handler!({ event_type: 'workunit.status_changed', data: { workunit: { id: 'WU-1' } } }));
    await waitFor(() => expect(screen.getByText(/暂无执行过程记录/)).toBeTruthy());
    expect(screen.queryByText('#5 · progress')).toBeNull();
    expect(mockListExecSteps).toHaveBeenCalledTimes(1);
  });

  it('SSE 重连 -> 一次性 refetch 对齐（ADR D3：重连 refetch 不回放）', async () => {
    render(<ExecutionSteps workUnitId="WU-1" />);
    await waitFor(() => expect(sse.reconnect).toBeTruthy());
    expect(mockListExecSteps).toHaveBeenCalledTimes(1);
    act(() => sse.reconnect!());
    await waitFor(() => expect(mockListExecSteps).toHaveBeenCalledTimes(2));
  });
});
