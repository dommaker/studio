// BlockedActions — #185（决策 #87 D1/D3/D4/D5）：blocked WU 的 Web 处置组件契约
// 「继续执行」仅卡住型显示（NEED_INPUT 型维持引导回复）；「关闭任务」全 blocked 类型 + 二次确认；
// 继续执行不确认（非破坏、可再拦截）；动作成功回调 onChanged；失败内联错误文案。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { mockResume, mockClose } = vi.hoisted(() => ({
  mockResume: vi.fn(),
  mockClose: vi.fn(),
}));

vi.mock('../../../api/workunit', async () => {
  const actual = await vi.importActual<typeof import('../../../api/workunit')>('../../../api/workunit');
  return {
    ...actual,
    workunitApi: { ...actual.workunitApi, resume: mockResume, close: mockClose },
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
