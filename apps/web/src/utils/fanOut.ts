// fanOut（#349）：并行扇出统一口径——单条失败隔离 + 结果与输入 index 对齐。
// 收敛前端四处手写的 allSettled/逐条 try-catch 扇出样板；每条 fetcher 立即发出（无并发上限）。
// 调用方自带归并策略（丢弃/兜底 null/兜底行），取消（cancelled/alive）仍留在调用侧。
export type FanOutEntry<R> = { ok: true; value: R } | { ok: false; error: unknown };

export async function fanOut<T, R>(
  items: readonly T[],
  fetcher: (item: T) => Promise<R>,
): Promise<Array<FanOutEntry<R>>> {
  return Promise.all(items.map(async (item): Promise<FanOutEntry<R>> => {
    try {
      return { ok: true, value: await fetcher(item) };
    } catch (error) {
      return { ok: false, error };
    }
  }));
}
