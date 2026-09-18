// BlockedActions — #185（决策 #87 D1/D3/D4/D5）：blocked WU 的 Web 处置组件契约
// 「继续执行」仅卡住型显示（NEED_INPUT 型维持引导回复）；「关闭任务」全 blocked 类型 + 二次确认；
// 继续执行不确认（非破坏、可再拦截）；动作成功回调 onChanged；失败内联错误文案。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { mockResume, mockClose, mockSubmitRuling, mockSubmitDirection } = vi.hoisted(() => ({
  mockResume: vi.fn(),
  mockClose: vi.fn(),
  mockSubmitRuling: vi.fn(),
  mockSubmitDirection: vi.fn(),
}));

vi.mock('../../../api/workunit', async () => {
  const actual = await vi.importActual<typeof import('../../../api/workunit')>('../../../api/workunit');
  return {
    ...actual,
    workunitApi: { ...actual.workunitApi, resume: mockResume, close: mockClose, submitRuling: mockSubmitRuling, submitDirection: mockSubmitDirection },
  };
});

import { BlockedActions } from '../BlockedActions';
import type { WorkUnit } from '../../../api/workunit';

const blockedWu = (metadata: Record<string, unknown> = {}, overrides: Partial<WorkUnit> = {}): WorkUnit => ({
  id: 'WU-1',
  parentId: null,
  dependsOn: '',
  type: 'task',
  scope: '实现登录功能',
  assigneeId: 'inst-1',
  status: 'blocked',
  failureType: null,
  retryCount: 0,
  timeoutAt: null,
  channelId: 'ch-1',
  metadata: JSON.stringify({ title: '登录功能', ...metadata }),
  createdAt: '2026-08-16T09:00:00Z',
  updatedAt: '2026-08-16T10:00:00Z',
  claimedAt: null,
  completedAt: null,
  ...overrides,
});

describe('BlockedActions（#185 决策 #87）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResume.mockResolvedValue({ data: blockedWu({}, { status: 'active' }) });
    mockClose.mockResolvedValue({ data: blockedWu({}, { status: 'closed' }) });
  });

  it('非 blocked（active/done）→ 不渲染任何处置按钮', () => {
    const { container } = render(<BlockedActions wu={blockedWu({}, { status: 'active' })} />);
    expect(container.firstChild).toBeNull();
    const { container: c2 } = render(<BlockedActions wu={blockedWu({}, { status: 'done' })} />);
    expect(c2.firstChild).toBeNull();
  });

  it('卡住型 blocked（无 waitingForInput）→ 「继续执行」+「关闭任务」均显示', async () => {
    render(<BlockedActions wu={blockedWu({ blockReason: 'stuck: 连续 3 步无进展' })} />);
    expect(screen.getByRole('button', { name: '继续执行' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '关闭任务' })).toBeTruthy();
  });

  it('NEED_INPUT 型 blocked（waitingForInput）→ 不显示「继续执行」，仅「关闭任务」（D3：复活了也拿不到答案）', () => {
    render(<BlockedActions wu={blockedWu({ waitingForInput: true, waitingQuestion: '用 OAuth 吗？' })} />);
    expect(screen.queryByRole('button', { name: '继续执行' })).toBeNull();
    expect(screen.getByRole('button', { name: '关闭任务' })).toBeTruthy();
  });

  it('点「继续执行」→ 直接调 resume（无确认弹窗），成功后触发 onChanged', async () => {
    const onChanged = vi.fn();
    render(<BlockedActions wu={blockedWu()} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: '继续执行' }));
    await waitFor(() => expect(mockResume).toHaveBeenCalledWith('WU-1'));
    // 复活不确认（D5：非破坏、可再拦截）
    expect(screen.queryByText(/确定关闭/)).toBeNull();
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('点「关闭任务」→ 二次确认弹窗，未确认前不调 close；确认后调 close + onChanged', async () => {
    const onChanged = vi.fn();
    render(<BlockedActions wu={blockedWu()} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: '关闭任务' }));
    // 二次确认弹窗（含任务标题）
    expect(await screen.findByText(/确定关闭任务「登录功能」吗？/)).toBeTruthy();
    expect(mockClose).not.toHaveBeenCalled();
    // 确认键（弹窗内同名按钮为最后一个）
    const buttons = screen.getAllByRole('button', { name: '关闭任务' });
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(mockClose).toHaveBeenCalledWith('WU-1'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('关闭二次确认：取消 → 不调 close', async () => {
    render(<BlockedActions wu={blockedWu()} />);
    fireEvent.click(screen.getByRole('button', { name: '关闭任务' }));
    await screen.findByText(/确定关闭任务/);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(mockClose).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText(/确定关闭任务/)).toBeNull());
  });

  it('close 被拒（decision/spec 无 closed 状态，409）→ 内联错误文案，不触发 onChanged', async () => {
    const onChanged = vi.fn();
    mockClose.mockRejectedValue(new Error('该类型（decision，人工验收类）无 closed 状态，不支持关闭'));
    render(<BlockedActions wu={blockedWu({}, { type: 'decision' })} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: '关闭任务' }));
    await screen.findByText(/确定关闭任务/);
    const buttons = screen.getAllByRole('button', { name: '关闭任务' });
    fireEvent.click(buttons[buttons.length - 1]);
    expect(await screen.findByText(/无 closed 状态/)).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('resume 失败 → 内联错误文案，不触发 onChanged', async () => {
    const onChanged = vi.fn();
    mockResume.mockRejectedValue(new Error('网络错误'));
    render(<BlockedActions wu={blockedWu()} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: '继续执行' }));
    expect(await screen.findByText('网络错误')).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe('BlockedActions — #467 裁决轮（plan-ruling）', () => {
  const rulingMeta = {
    waitingForInput: true,
    waitingReason: 'plan-ruling',
    planRulings: [
      { question: '存储选型？', suggestion: 'SQLite' },
      { question: '部署形态？', suggestion: '单机' },
    ],
  };

  beforeEach(() => {
    mockSubmitRuling.mockResolvedValue({ data: blockedWu({}, { status: 'active' }) });
  });

  it('plan-ruling 挂起 → 显示「去裁决」，不显示「继续执行」（裁决须带结论，纯授权无意义）', () => {
    render(<BlockedActions wu={blockedWu(rulingMeta, { type: 'plan' })} />);
    expect(screen.getByRole('button', { name: '去裁决' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '继续执行' })).toBeNull();
  });

  it('点「去裁决」→ 弹 PlanRulingDialog（逐题预填建议结论）；提交 → submitRuling + onChanged', async () => {
    const onChanged = vi.fn();
    render(<BlockedActions wu={blockedWu(rulingMeta, { type: 'plan' })} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: '去裁决' }));
    expect(await screen.findByLabelText('结论 1')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '全部采纳' }));
    await waitFor(() => expect(mockSubmitRuling).toHaveBeenCalledWith('WU-1', {
      items: [
        { question: '存储选型？', action: 'accept', conclusion: 'SQLite' },
        { question: '部署形态？', action: 'accept', conclusion: '单机' },
      ],
    }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('autoRuling（接力卡「去裁决」打开即弹）→ 挂载即自动弹窗（一次性）', async () => {
    render(<BlockedActions wu={blockedWu(rulingMeta, { type: 'plan' })} autoRuling />);
    expect(await screen.findByLabelText('结论 1')).toBeTruthy();
  });

  it('非 plan-ruling 的 blocked → 无「去裁决」入口', () => {
    render(<BlockedActions wu={blockedWu({ waitingForInput: true, waitingQuestion: 'q' })} />);
    expect(screen.queryByRole('button', { name: '去裁决' })).toBeNull();
  });

  it('submitRuling 失败 → 错误内联（弹窗保持打开），不触发 onChanged', async () => {
    const onChanged = vi.fn();
    mockSubmitRuling.mockRejectedValue(new Error('该任务无待裁的裁决轮'));
    render(<BlockedActions wu={blockedWu(rulingMeta, { type: 'plan' })} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: '去裁决' }));
    fireEvent.click(await screen.findByRole('button', { name: '全部采纳' }));
    expect(await screen.findByText('该任务无待裁的裁决轮')).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe('BlockedActions — #567 方向锁定（plan-direction）', () => {
  const directionMeta = {
    waitingForInput: true,
    waitingReason: 'plan-direction',
    planDirections: {
      question: '存储自研还是引入依赖？',
      options: [
        { name: '自研存储层', summary: '自控力强', tradeoffs: '周期长', impact: '触及 storage 模块', recommended: true },
        { name: '引入 SQLite 库', summary: '快速落地', tradeoffs: '绑定上游', impact: '新增依赖', recommended: false },
      ],
    },
  };

  beforeEach(() => {
    mockSubmitDirection.mockResolvedValue({ data: blockedWu({}, { status: 'active' }) });
  });

  it('plan-direction 挂起 → 显示「去选定」，不显示「继续执行」（NEED_INPUT 型；方向须带选定结论）', () => {
    render(<BlockedActions wu={blockedWu(directionMeta, { type: 'plan' })} />);
    expect(screen.getByRole('button', { name: '去选定' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '继续执行' })).toBeNull();
  });

  it('点「去选定」→ 弹 PlanDirectionDialog（抉择点 + 候选卡）；提交 → submitDirection + onChanged', async () => {
    const onChanged = vi.fn();
    render(<BlockedActions wu={blockedWu(directionMeta, { type: 'plan' })} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: '去选定' }));
    expect(await screen.findByText('存储自研还是引入依赖？')).toBeTruthy();

    // 改选非推荐项 + 补充说明
    fireEvent.click(screen.getByLabelText('方向：引入 SQLite 库'));
    fireEvent.change(screen.getByLabelText('补充说明'), { target: { value: '赶工期' } });
    fireEvent.click(screen.getByRole('button', { name: '锁定所选方向' }));
    await waitFor(() => expect(mockSubmitDirection).toHaveBeenCalledWith('WU-1', {
      choice: '引入 SQLite 库',
      note: '赶工期',
    }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('autoDirection（接力卡「去选定」打开即弹）→ 挂载即自动弹窗（一次性）', async () => {
    render(<BlockedActions wu={blockedWu(directionMeta, { type: 'plan' })} autoDirection />);
    expect(await screen.findByText('存储自研还是引入依赖？')).toBeTruthy();
  });

  it('非 plan-direction 的 blocked → 无「去选定」入口', () => {
    render(<BlockedActions wu={blockedWu({ waitingForInput: true, waitingQuestion: 'q' })} />);
    expect(screen.queryByRole('button', { name: '去选定' })).toBeNull();
  });

  it('submitDirection 失败 → 错误内联（弹窗保持打开），不触发 onChanged', async () => {
    const onChanged = vi.fn();
    mockSubmitDirection.mockRejectedValue(new Error('该任务无待选的方向'));
    render(<BlockedActions wu={blockedWu(directionMeta, { type: 'plan' })} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: '去选定' }));
    fireEvent.click(await screen.findByRole('button', { name: '锁定推荐方向' }));
    expect(await screen.findByText('该任务无待选的方向')).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
  });
});
