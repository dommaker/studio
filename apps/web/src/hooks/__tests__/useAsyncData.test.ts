// useAsyncData — 一次性拉取共享 hook（#350）：挂载首拉 + loading/error + deps 渲染期重置 + reload
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

import { useAsyncData } from '../useAsyncData';

/** 首拉走微任务：等一拍让 fetcher 被调用、resolver 登记 */
async function flushFetch() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useAsyncData', () => {
  it('挂载首拉：初始 loading 为真，落地后 data 更新、loading 落假', async () => {
    const fetcher = vi.fn(() => Promise.resolve('v1'));
    const { result } = renderHook(() => useAsyncData(fetcher, []));

    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBe('v1');
    expect(result.current.error).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('首拉失败：error 为 Error.message，data 保持 null', async () => {
    const { result } = renderHook(() => useAsyncData(() => Promise.reject(new Error('boom')), []));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('boom');
    expect(result.current.data).toBeNull();
  });

  it('非 Error 抛出：error 落默认文案', async () => {
    const { result } = renderHook(() => useAsyncData(() => Promise.reject('nope'), []));

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error).toBe('Failed to load');
  });

  it('deps 变化：渲染期同步清 data 置回 loading，再拉新参', async () => {
    let param = 'a';
    const { result, rerender } = renderHook(() => useAsyncData(() => Promise.resolve(`v-${param}`), [param]));

    await waitFor(() => expect(result.current.data).toBe('v-a'));

    param = 'b';
    rerender();

    // 渲染期重置：不经过微任务即可见（不等下一帧）
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.data).toBe('v-b'));
  });

  it('reload：保留旧数据重拉，成功后替换', async () => {
    const resolvers: Array<(v: string) => void> = [];
    const fetcher = vi.fn(() => new Promise<string>(res => resolvers.push(res)));
    const { result } = renderHook(() => useAsyncData(fetcher, []));
    await flushFetch();

    act(() => { resolvers[0]('v1'); });
    await waitFor(() => expect(result.current.data).toBe('v1'));

    act(() => { result.current.reload(); });
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBe('v1'); // 重拉期间旧数据保留

    await flushFetch();
    act(() => { resolvers[1]('v2'); });
    await waitFor(() => expect(result.current.data).toBe('v2'));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('reload 清 error；重拉失败时旧数据保留、error 更新', async () => {
    const resolvers: Array<(v: string) => void> = [];
    const rejecters: Array<(e: unknown) => void> = [];
    let fail = false;
    const { result } = renderHook(() => useAsyncData(() => (fail
      ? new Promise<string>((_res, rej) => rejecters.push(rej))
      : new Promise<string>(res => resolvers.push(res))), []));
    await flushFetch();

    act(() => { resolvers[0]('v1'); });
    await waitFor(() => expect(result.current.data).toBe('v1'));

    fail = true;
    act(() => { result.current.reload(); });
    expect(result.current.error).toBeNull(); // reload 即清 error
    await flushFetch();
    act(() => { rejecters[0](new Error('again')); });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('again');
    expect(result.current.data).toBe('v1'); // 失败不清旧数据

    // 再成功：error 清空
    fail = false;
    act(() => { result.current.reload(); });
    await flushFetch();
    act(() => { resolvers[1]('v2'); });
    await waitFor(() => expect(result.current.data).toBe('v2'));
    expect(result.current.error).toBeNull();
  });

  it('deps 变化后旧响应不落地（alive 守卫）', async () => {
    const resolvers: Array<(v: string) => void> = [];
    let param = 'a';
    const { result, rerender } = renderHook(
      () => useAsyncData(() => new Promise<string>(res => resolvers.push(res)), [param]),
    );

    param = 'b';
    rerender();
    await flushFetch();

    act(() => { resolvers[1]('new'); }); // 新参先回
    await waitFor(() => expect(result.current.data).toBe('new'));

    act(() => { resolvers[0]('stale'); }); // 旧参响应迟到
    expect(result.current.data).toBe('new');
  });
});
