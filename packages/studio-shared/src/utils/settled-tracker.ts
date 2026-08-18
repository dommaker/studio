/**
 * 确定性等待原语（#158 progress-rollup 先例，#228 归并三处复制为单一实现）：
 * fire-and-forget 异步链（事件订阅消费 / best-effort 收尾）的在途登记 + settled 等待，
 * 供测试替代盲等（waitFor 轮询 / 定长 sleep）——全量负载下事件循环饥饿会吃满盲等预算。
 *
 * 用法：发射点（publish / 触发方同步链内）调用 track(链 promise) 登记；
 * 测试侧 await waitForSettled() 即确定性等到链路落定。
 * 纯增量：只在原 promise 上挂 then 反应，不改变发布/消费行为。
 */
export interface SettledTracker {
  /** 登记在途 promise（调用方原有的 .catch 处理不受影响） */
  track(p: Promise<unknown>): void;
  /** 等待当前已登记的全部在途落定；等待期间新登记的（级联触发）也一并等完 */
  waitForSettled(): Promise<void>;
}

export function createSettledTracker(): SettledTracker {
  const inFlight = new Set<Promise<unknown>>();
  return {
    track(p: Promise<unknown>): void {
      inFlight.add(p);
      const done = () => { inFlight.delete(p); };
      p.then(done, done);
    },
    async waitForSettled(): Promise<void> {
      // while 循环兜底级联：等待期间新触发的在途也一并等完
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
    },
  };
}
