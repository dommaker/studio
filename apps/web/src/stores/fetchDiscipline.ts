// 取数纪律底座（#403，ADR 2026-08-31-channel-data-plane-store 决策 6）
// 只抽「何时发起拉取、结果能否落库」的纪律，不抽数据存法——全局单份（rosterStore）
// 与 per-key map（channelDataStore）各自组合本模块。
// 纪律四件：TTL 锚点 / single-flight（force 不并入在途）/ seq 守卫（晚到旧结果不落库）/
// inflight 生命周期（只清自己的锚点）。重连强刷 / 门禁轮询 / 引用计数接线在 useDataPlaneSync。
export interface FetchGateState {
  /** 任一成功落库的时间戳（TTL 锚点；全失败不更新 → 下次调用重试） */
  loadedAt: number | null;
  /** 进行中的拉取（single-flight 去重锚点） */
  inflight: Promise<void> | null;
}

export interface FetchGate {
  /** 本次拉取序号（单调递增）；发布结果前用 isLatest 自检 */
  nextSeq(): number;
  /** 晚到的旧 fetch（被强拉/后续拉取超越）不得回写 */
  isLatest(seq: number): boolean;
}

export function createFetchGate(): FetchGate {
  let seq = 0;
  return {
    nextSeq: () => ++seq,
    isLatest: (s) => s === seq,
  };
}

export interface FetchGateOps {
  read: () => FetchGateState;
  /** 写 inflight 锚点（null = 清除） */
  setInflight: (p: Promise<void> | null) => void;
}

/**
 * 取数纪律一次收口。返回值语义：
 * - 返回在途 Promise = 并入 single-flight（maxAgeMs≠0 且有在途；调用方 await 同一次拉取）
 * - 返回 resolved Promise = TTL 内免拉
 * - 新发起 = maxAgeMs 传 0 强拉（不并入在途：旧 fetch 早于动作发起，并入会丢本次对齐；
 *   序号守卫保证旧结果不落地）；bypassTtl 跳过 TTL 检查但仍并入在途（rosterStore 换号语义）。
 * makeBody 内发布结果前必须 gate.isLatest(seq) 自检；错误自行捕获（ensureFresh 永不 reject 契约归调用方）。
 */
export function disciplinedFetch(
  gate: FetchGate,
  ops: FetchGateOps,
  opts: { maxAgeMs: number; bypassTtl?: boolean },
  makeBody: (seq: number) => Promise<void>,
): Promise<void> {
  const state = ops.read();
  if (state.inflight && opts.maxAgeMs !== 0) return state.inflight;
  if (!opts.bypassTtl && state.loadedAt !== null && Date.now() - state.loadedAt < opts.maxAgeMs) {
    return Promise.resolve();
  }
  const seq = gate.nextSeq();
  const promise = (async () => makeBody(seq))().finally(() => {
    // 只清自己的 inflight（被超越时不误清新 fetch 的锚点）
    if (gate.isLatest(seq)) ops.setInflight(null);
  });
  ops.setInflight(promise);
  return promise;
}
