// ExecutionSteps - WU 过程可视化组件：执行步事件流 + Layer B 步内实时 chunk
// 从 WorkUnitDrawer 抽取的复用组件，独立验证渲染契约（步事件/空态/实时/让位）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const { mockListExecSteps, mockStreamChunks } = vi.hoisted(() => ({
  mockListExecSteps: vi.fn(),
  mockStreamChunks: vi.fn(),
}));

vi.mock('../../../api/workunit', async () => {
  const actual = await vi.importActual('../../../api/workunit');
  return {
    ...actual,
    workunitApi: { listExecutionStepEvents: mockListExecSteps },
  };
});

// SSE 事件 hook - 测试无 WebSocketProvider，置空
vi.mock('../../../hooks/useWorkUnitEvents', () => ({
  useWorkUnitEvents: () => {},
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
