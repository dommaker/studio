// useProposalReview — #352 提案卡审核生命周期单一实现（ADR 2026-08-25 决策 5）
// 契约：reviewed/pending/armed + 挂载期派生已审态（配置 fetchReviewed，失败静默保持待审，不实时推送）
// + act 包装（onAction false 保持待审；成功落入配置终态词）。派生三写法的 diff 全部收进配置。
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useProposalReview } from '../useProposalReview';
import type { ProposalCardConfig } from '../../components/channel/proposalCardConfigs';

const makeConfig = (over: Partial<ProposalCardConfig> = {}): ProposalCardConfig => ({
  cardType: 'x_proposal',
  kind: 'x',
  approveAction: 'x_approve',
  rejectAction: 'x_reject',
  approvedState: 'executed',
  exec: vi.fn(),
  reviewedTitle: 'X',
  reviewLabels: {
    executed: { text: '已执行', cls: 'mc-status-done' },
    rejected: { text: '已拒绝', cls: 'mc-status-error' },
  },
  pendingTitle: 'X — 待确认',
  countText: () => '0 条',
  approveLabel: '确认',
  rejectLabel: '拒绝',
  renderContent: () => null,
  ...over,
});

const setup = (config: ProposalCardConfig, opts: { metaStatus?: string; onAction?: ReturnType<typeof vi.fn> } = {}) =>
  renderHook(() =>
    useProposalReview({
      config,
      meta: { cardType: config.cardType, status: opts.metaStatus ?? 'ready', cardData: { id: 'p-1' } },
      messageId: 'msg-1',
      onAction: opts.onAction ?? vi.fn(),
    }),
  );

describe('useProposalReview — 审核生命周期单一实现', () => {
  it('无 fetchReviewed 且 meta.status 非终态 → 初始保持待审', () => {
    const { result } = setup(makeConfig());
    expect(result.current.reviewed).toBeNull();
    expect(result.current.pending).toBe(false);
    expect(result.current.armed).toBe(false);
  });

  it('initialReviewed 命中 meta.status → 立即已审，fetchReviewed 不再调用', async () => {
    const fetchReviewed = vi.fn();
    const config = makeConfig({
      initialReviewed: s => (s === 'approved' ? 'approved' : null),
      fetchReviewed,
    });
    const { result } = setup(config, { metaStatus: 'approved' });
    expect(result.current.reviewed).toBe('approved');
    await waitFor(() => expect(fetchReviewed).not.toHaveBeenCalled());
  });

  it('fetchReviewed 挂载期查一次：返回终态 → 派生已审态', async () => {
    const fetchReviewed = vi.fn().mockResolvedValue('executed');
    const { result } = setup(makeConfig({ fetchReviewed }));
    await waitFor(() => expect(result.current.reviewed).toBe('executed'));
    expect(fetchReviewed).toHaveBeenCalledTimes(1);
    expect(fetchReviewed).toHaveBeenCalledWith({ id: 'p-1' });
  });

  it('fetchReviewed 返回 null → 保持待审', async () => {
    const fetchReviewed = vi.fn().mockResolvedValue(null);
    const { result } = setup(makeConfig({ fetchReviewed }));
    await waitFor(() => expect(fetchReviewed).toHaveBeenCalled());
    expect(result.current.reviewed).toBeNull();
  });

  it('fetchReviewed 抛错 → 静默保持待审', async () => {
    const fetchReviewed = vi.fn().mockRejectedValue(new Error('network'));
    const { result } = setup(makeConfig({ fetchReviewed }));
    await waitFor(() => expect(fetchReviewed).toHaveBeenCalled());
    expect(result.current.reviewed).toBeNull();
  });

  it('act(approve) → onAction(messageId, approveAction)，成功后落入 approvedState；act(reject) → rejected', async () => {
    const onAction = vi.fn().mockResolvedValue(true);
    const { result, unmount } = setup(makeConfig(), { onAction });
    await act(async () => { await result.current.act('approve'); });
    expect(onAction).toHaveBeenCalledWith('msg-1', 'x_approve');
    expect(result.current.reviewed).toBe('executed');
    unmount();

    const onAction2 = vi.fn().mockResolvedValue(true);
    const { result: result2 } = setup(makeConfig(), { onAction: onAction2 });
    await act(async () => { await result2.current.act('reject'); });
    expect(onAction2).toHaveBeenCalledWith('msg-1', 'x_reject');
    expect(result2.current.reviewed).toBe('rejected');
  });

  it('act 返回 false → 保持待审；undefined 视为成功', async () => {
    const onAction = vi.fn().mockResolvedValue(false);
    const { result, unmount } = setup(makeConfig(), { onAction });
    await act(async () => { await result.current.act('approve'); });
    expect(result.current.reviewed).toBeNull();
    unmount();

    const onAction2 = vi.fn().mockResolvedValue(undefined);
    const { result: result2 } = setup(makeConfig(), { onAction: onAction2 });
    await act(async () => { await result2.current.act('approve'); });
    expect(result2.current.reviewed).toBe('executed');
  });

  it('#367：act 返回 false 后按提案状态重派生一次——命中终态即时收敛，null/抛错保持待审', async () => {
    const fetchReviewed = vi.fn().mockResolvedValue('failed');
    const config = makeConfig({ fetchReviewed });
    const { result } = setup(config, { onAction: vi.fn().mockResolvedValue(false) });
    await act(async () => { await result.current.act('approve'); });
    expect(result.current.reviewed).toBe('failed');

    const fetchNull = vi.fn().mockResolvedValue(null);
    const cfg2 = makeConfig({ fetchReviewed: fetchNull });
    const { result: r2 } = setup(cfg2, { onAction: vi.fn().mockResolvedValue(false) });
    await act(async () => { await r2.current.act('reject'); });
    expect(r2.current.reviewed).toBeNull();

    const fetchBoom = vi.fn().mockRejectedValue(new Error('network'));
    const cfg3 = makeConfig({ fetchReviewed: fetchBoom });
    const { result: r3 } = setup(cfg3, { onAction: vi.fn().mockResolvedValue(false) });
    await act(async () => { await r3.current.act('approve'); });
    expect(r3.current.reviewed).toBeNull();
  });

  it('act 期间 pending 锁存；执行完毕（含失败）armed 复位（#288 失败重武装）', async () => {
    let resolve: (v: boolean) => void = () => {};
    const onAction = vi.fn().mockImplementation(() => new Promise<boolean>(r => { resolve = r; }));
    const { result } = setup(makeConfig(), { onAction });
    act(() => { result.current.setArmed(true); });
    expect(result.current.armed).toBe(true);

    let actPromise: Promise<void>;
    act(() => { actPromise = result.current.act('approve'); });
    expect(result.current.pending).toBe(true);

    await act(async () => { resolve(false); await actPromise; });
    expect(result.current.pending).toBe(false);
    expect(result.current.armed).toBe(false);
    expect(result.current.reviewed).toBeNull();
  });
});
