// useMergePreview（#691 自 ChannelInput 抽出）：#632 归属预览状态机——触发四条件
// （内容非空 / 无 replyTo / 无 @mention / 非发送中）、400ms 防抖、失败静默撤条、
// seq 守卫（在途旧响应不覆盖新结果）、频道切换预览与选择复位。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const { mockGetMergeTarget } = vi.hoisted(() => ({ mockGetMergeTarget: vi.fn() }));

vi.mock('../../api/channel', () => ({
  channelApi: { getMergeTarget: mockGetMergeTarget },
}));

import { useMergePreview } from '../useMergePreview';
import type { ChannelMessage } from '../../api/channel';

const replyTo = { id: 'm-1' } as ChannelMessage;
const preview = { status: 'unique', workUnit: { id: 'wu-1', title: 't' } } as const;
const ok = (data: unknown = preview) => Promise.resolve({ data: { data } });

function setup(props: Partial<Parameters<typeof useMergePreview>[0]> = {}) {
  return renderHook((p: Parameters<typeof useMergePreview>[0]) => useMergePreview(p), {
    initialProps: { channelId: 'ch-1', content: 'hello', sending: false, ...props },
  });
}

describe('useMergePreview', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockGetMergeTarget.mockResolvedValue(ok());
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('满足触发条件 → 400ms 防抖后拉取并落 preview', async () => {
    const { result } = setup();
    expect(result.current.mergePreviewEligible).toBe(true);
    expect(mockGetMergeTarget).not.toHaveBeenCalled(); // 防抖窗口内不发请求
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(mockGetMergeTarget).toHaveBeenCalledWith('ch-1');
    expect(result.current.mergePreview).toEqual(preview);
  });

  it.each([
    ['空内容', { content: '  ' }],
    ['有 replyTo', { replyTo }],
    ['含 @mention', { content: '@dev 看下' }],
    ['发送中', { sending: true }],
    ['无 channelId', { channelId: undefined }],
  ])('触发条件不满足（%s）→ eligible=false 且不拉取', async (_label, overrides) => {
    const { result } = setup(overrides);
    expect(result.current.mergePreviewEligible).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(mockGetMergeTarget).not.toHaveBeenCalled();
    expect(result.current.mergePreview).toBeNull();
  });

  it('拉取失败 → 静默撤条（preview=null）', async () => {
    mockGetMergeTarget.mockRejectedValue(new Error('boom'));
    const { result } = setup();
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(result.current.mergePreview).toBeNull();
  });

  it('频道切换 → 预览与选择一并复位', async () => {
    const { result, rerender } = setup();
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(result.current.mergePreview).toEqual(preview);
    act(() => { result.current.setMergeChoice('new-task'); });
    expect(result.current.mergeChoice).toBe('new-task');

    rerender({ channelId: 'ch-2', content: 'hello', sending: false });
    expect(result.current.mergePreview).toBeNull();
    expect(result.current.mergeChoice).toBe('auto');
  });

  it('seq 守卫：条件失效后在途旧响应不覆盖（撤条生效）', async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    mockGetMergeTarget.mockImplementationOnce(() => new Promise(r => { resolveFirst = r; }));
    const { result, rerender } = setup();
    await act(async () => { await vi.advanceTimersByTimeAsync(400); }); // 发出首个请求
    rerender({ channelId: 'ch-1', content: '', sending: false }); // 内容清空 → 撤条 ++seq
    expect(result.current.mergePreview).toBeNull();
    await act(async () => { resolveFirst(ok()); await Promise.resolve(); });
    expect(result.current.mergePreview).toBeNull(); // 旧响应被 seq 守卫丢弃
  });
});
