/**
 * 按 key 的 Promise 链式串行化——pmo/ 内 map 写五处同构拷贝的收口
 * （map-opening / decision-resolution / spec-materialization / progress-rollup / plan-ruling）。
 *
 * 语义（与五份拷贝逐行等价）：
 * - 同 key 任务严格排队，前序失败不阻断后续；
 * - 不同 key 互不阻塞；
 * - 链尾回收，Map 不随 key 数无限增长。
 *
 * 注意：每个消费方持独立实例（各自的 Map），不跨模块共享链——保持重构前
 * 「每个模块各自串行」的隔离语义，不引入跨模块排序耦合。
 */

export type KeyedEnqueue = (key: string, task: () => Promise<void>) => Promise<void>;

export function createKeyedEnqueue(): KeyedEnqueue {
  const chains = new Map<string, Promise<void>>();
  return (key, task) => {
    const run = (chains.get(key) ?? Promise.resolve())
      .catch(() => { /* 前序失败不阻断后续 */ })
      .then(task);
    chains.set(key, run);
    const cleanup = () => { if (chains.get(key) === run) chains.delete(key); };
    run.then(cleanup, cleanup);
    return run;
  };
}
