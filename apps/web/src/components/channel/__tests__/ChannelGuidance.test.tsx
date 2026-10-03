// ChannelGuidance — P3-b 自 ChannelDetailPage 切出的引导片区：
// 端点派生片模板渲染（未知模板 fail-closed）/ prompt 点击 onPrefill / #484 片粒度 dismiss /
// #444 动作片一次确认 → 确定性接口 → refreshSuggestions 回扫；失败原因内联进弹窗不静默
// （模板文案有 suggestionCopy.test.ts 快照正本，此处用真实注册表只锁接线不锁文案）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { mockRefreshSuggestions, mockDispatchReview } = vi.hoisted(() => ({
  mockRefreshSuggestions: vi.fn(),
  mockDispatchReview: vi.fn(),
}));

vi.mock('../../../stores/channelWorkStore', () => ({
  useChannelWorkStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({}),
    { getState: () => ({ refreshSuggestions: mockRefreshSuggestions }) },
  ),
}));

// 动作执行体走真实注册表（suggestionActions），只 mock 底层 API
vi.mock('../../../api/workunit', () => ({
  workunitApi: { dispatchReview: mockDispatchReview, claim: vi.fn() },
}));

import { ChannelGuidance } from '../ChannelGuidance';
import type { ChannelSuggestion } from '../../api/channel';

const SUGGESTIONS = [
  { id: 'diagnose-blocked', kind: 'prompt', text: '诊断指令本体', params: { wuId: 'wu-1', wuTitle: '工单一', blockReason: '等依赖' } },
  { id: 'redispatch-review', kind: 'action', params: { wuId: 'wu-2', wuTitle: '工单二' } },
  // 未注册模板 id → fail-closed 不渲染
  { id: 'no-such-template', params: { wuId: 'wu-3' } },
] as unknown as ChannelSuggestion[];

const renderGuidance = (suggestions = SUGGESTIONS) => {
  const onPrefill = vi.fn();
  render(<ChannelGuidance channelId="ch-1" suggestions={suggestions} onPrefill={onPrefill} />);
  return onPrefill;
};

describe('ChannelGuidance — P3-b 引导片区', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDispatchReview.mockResolvedValue({});
  });

  it('端点派生片经模板渲染成引导片；未知模板 fail-closed 跳过', () => {
    renderGuidance();
    expect(screen.getByRole('group', { name: '下一步建议' })).toBeTruthy();
    expect(screen.getByText('诊断阻塞：《工单一》')).toBeTruthy();
    expect(screen.getByText('补派评审：《工单二》')).toBeTruthy();
    expect(screen.queryByText(/no-such-template/)).toBeNull();
  });

  it('prompt 片点击 → onPrefill 上送后端 text 指令本体（不自动发送）', () => {
    const onPrefill = renderGuidance();
    fireEvent.click(screen.getByText('诊断阻塞：《工单一》'));
    expect(onPrefill).toHaveBeenCalledWith('诊断指令本体');
  });

  it('#484：片粒度 dismiss——✕ 只移除被点片，其余片保留', () => {
    renderGuidance();
    fireEvent.click(screen.getByLabelText('关闭建议：诊断阻塞：《工单一》'));
    expect(screen.queryByText('诊断阻塞：《工单一》')).toBeNull();
    expect(screen.getByText('补派评审：《工单二》')).toBeTruthy();
  });

  it('动作片 → 一次确认弹窗 → 确定性接口 → 关窗 + refreshSuggestions 回扫', async () => {
    renderGuidance();
    fireEvent.click(screen.getByText('补派评审：《工单二》'));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('补派评审');
    expect(dialog.textContent).toContain('工单二');
    fireEvent.click(screen.getByRole('button', { name: '确认补派' }));

    await waitFor(() => expect(mockDispatchReview).toHaveBeenCalledWith('wu-2'));
    await waitFor(() => expect(mockRefreshSuggestions).toHaveBeenCalledWith('ch-1'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('动作执行失败：原因内联进弹窗不静默，弹窗保持打开可重试', async () => {
    mockDispatchReview.mockRejectedValue(new Error('409 前置条件不满足'));
    renderGuidance();
    fireEvent.click(screen.getByText('补派评审：《工单二》'));
    fireEvent.click(await screen.findByRole('button', { name: '确认补派' }));

    expect(await screen.findByText('409 前置条件不满足')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(mockRefreshSuggestions).not.toHaveBeenCalled();
  });

  it('确认弹窗取消：不执行动作', async () => {
    renderGuidance();
    fireEvent.click(screen.getByText('补派评审：《工单二》'));
    fireEvent.click(await screen.findByRole('button', { name: '取消' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mockDispatchReview).not.toHaveBeenCalled();
  });

  it('空建议集 → 不渲染引导片组', () => {
    renderGuidance([]);
    expect(screen.queryByRole('group', { name: '下一步建议' })).toBeNull();
  });
});
