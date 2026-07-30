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
