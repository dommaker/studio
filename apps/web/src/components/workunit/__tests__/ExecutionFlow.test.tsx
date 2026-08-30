// #396：执行过程新组件 ExecutionFlow —— stat 摘要行 + 纵向 step 链（替代详情页 ExecutionSteps 表格形态）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

const { mockListSteps } = vi.hoisted(() => ({ mockListSteps: vi.fn() }));

vi.mock('../../../api/workunit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/workunit')>();
  return { ...actual, workunitApi: { ...actual.workunitApi, listExecutionStepEvents: mockListSteps } };
});

vi.mock('../../../api/websocketHooks', () => ({
  useWebSocketContext: () => ({ onEvent: () => () => {}, onReconnect: () => () => {} }),
}));

import { ExecutionFlow } from '../ExecutionFlow';
import type { WorkUnit } from '../../../api/workunit';

const baseWu: WorkUnit = {
  id: 'wu-1',
  parentId: null,
  dependsOn: '',
  type: 'task',
  scope: '实现登录功能',
  assigneeId: 'inst-1',
  status: 'active',
  failureType: null,
  retryCount: 0,
  timeoutAt: null,
  channelId: 'ch-1',
  metadata: JSON.stringify({ stepCount: 2, progressLog: [{ step: 2, summary: '测试编写中' }] }),
  createdAt: '2026-07-30T09:00:00Z',
  updatedAt: '2026-07-30T10:00:00Z',
  claimedAt: '2026-07-30T09:30:00Z',
  completedAt: null,
};

const step1 = {
  workUnitId: 'wu-1', executionId: 'ex-1', step: 1, action: '读代码', status: 'success',
  thinking: ['先看结构'], toolCalls: [{ tool: 'Read', summary: 'src/a.ts' }], skills: ['tdd'],
  usage: { inputTokens: 1000, outputTokens: 500 }, at: '2026-07-30T09:31:00Z', text: '完成读取',
};
const step2 = {
  workUnitId: 'wu-1', executionId: 'ex-1', step: 2, action: '写测试', status: 'failed',
  errorType: 'execution_failed', errorDetail: 'vitest 退出码 1',
  thinking: [], toolCalls: [{ tool: 'Bash', summary: 'pnpm test' }], skills: [],
  usage: { inputTokens: 2000, outputTokens: 1000 }, at: '2026-07-30T09:40:00Z',
};

function row(payload: unknown) {
  return { payload: JSON.stringify(payload) };
}

describe('ExecutionFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListSteps.mockResolvedValue({ data: { events: [row(step1), row(step2)], total: 2 } });
  });

  it('stat 摘要行：状态徽章 / 进度（第 N 步 / 上限）/ 累计 token（合计 formatting）', async () => {
    render(<ExecutionFlow workUnitId="wu-1" wu={baseWu} />);
    expect(await screen.findByText('读代码')).toBeDefined();
    expect(screen.getByText('状态')).toBeDefined();
    expect(screen.getByText('执行中')).toBeDefined();
    expect(screen.getByText('进度')).toBeDefined();
    expect(screen.getAllByText(/第 2 步/).length).toBeGreaterThan(0);
    expect(screen.getByText(/上限 15/)).toBeDefined();
    // 1500 + 3000 = 4500 → 4.5k
    expect(screen.getByText('累计 token')).toBeDefined();
    expect(screen.getByText('4.5k')).toBeDefined();
  });

  it('review 型 WU 步数上限 30', async () => {
    render(<ExecutionFlow workUnitId="wu-1" wu={{ ...baseWu, type: 'review' }} />);
    expect(await screen.findByText(/上限 30/)).toBeDefined();
  });

  it('最近进展取 progressLog 末条；失败步红色警示行', async () => {
    render(<ExecutionFlow workUnitId="wu-1" wu={baseWu} />);
    expect(await screen.findByText(/第 2 步：测试编写中/)).toBeDefined();
    expect(screen.getByText(/✗ 第 2 步失败：vitest 退出码 1/)).toBeDefined();
  });

  it('step 链：步骤号节点 + action 标题；thinking 折叠（details 默认闭合）；tool 成行 mono；失败步红节点 + 红 tag + 错误详情', async () => {
    const { container } = render(<ExecutionFlow workUnitId="wu-1" wu={baseWu} />);
    await screen.findByText('读代码');
    // 步号节点
    expect(container.querySelectorAll('.wu-flow-step').length).toBe(2);
    expect(container.querySelectorAll('.wu-flow-num').length).toBe(2);
    // thinking 弱显折叠
    const thinking = container.querySelector('details.wu-flow-thinking');
    expect(thinking).not.toBeNull();
    expect(thinking!.hasAttribute('open')).toBe(false);
    expect(screen.getByText('思考 ×1')).toBeDefined();
    // tool 成行
    expect(screen.getByText('Read')).toBeDefined();
    expect(screen.getByText('src/a.ts')).toBeDefined();
    expect(screen.getByText('Bash')).toBeDefined();
    // 失败步
    const failed = container.querySelector('.wu-flow-step.wu-flow-failed');
    expect(failed).not.toBeNull();
    expect(screen.getByText('失败')).toBeDefined();
    expect(screen.getByText(/execution_failed：vitest 退出码 1/)).toBeDefined();
    // skills / 正文
    expect(screen.getByText(/skills：tdd/)).toBeDefined();
    expect(screen.getByText('完成读取')).toBeDefined();
  });

  it('加载中 → 「加载中…」；空事件 → 空态文案；接口失败 → 空态不炸', async () => {
    mockListSteps.mockReturnValue(new Promise(() => {}));
    const { unmount } = render(<ExecutionFlow workUnitId="wu-1" wu={baseWu} />);
    expect(screen.getByText('加载中…')).toBeDefined();
    unmount();

    mockListSteps.mockResolvedValue({ data: { events: [], total: 0 } });
    render(<ExecutionFlow workUnitId="wu-1" wu={baseWu} />);
    expect(await screen.findByText(/暂无执行过程记录/)).toBeDefined();
  });
});
