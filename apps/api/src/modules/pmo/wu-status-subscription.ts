/**
 * WuStatusChangedSubscription — 「幂等订阅 workunit.status_changed + 在途事件链登记」
 * 共享骨架（P2.1 收敛：原 analysis-handoff / map-opening / spec-materialization
 * 三处各持一份 subscribed 标志 + settled tracker + subscribeToEvents 的复制）。
 *
 * 收敛时保留的语义差异（三消费方注入，不抹平）：
 *   - 过滤条件各不相同：analysis-handoff 只看 analysis/plan（状态分流在 handler 内），
 *     map-opening 是 analysis/plan + done，spec-materialization 是 spec + done；
 *   - 吞错策略由 handle 调用方自定（三处现状均自带 catch，登记的链永不 rejection）。
 *
 * decision-resolution 形态不同（无 settled tracker、subscriber 内 await），未纳入本骨架。
 */

import { eventBus, createSettledTracker } from '@dommaker/studio-shared';
import type { WorkUnitData } from '../workunit/index.js';


export class WuStatusChangedSubscription {
  private subscribed = false;
  private readonly settled = createSettledTracker();

  /**
   * 幂等订阅：重复调用只挂一次监听。
   * 每个事件先过 filter（缺省全放行），命中则调 handle 并把返回的 Promise
   * 登记进 settled tracker（供 waitForSettled 等在途链落定，替代盲等轮询）。
   */
  subscribe(
    filter: ((wu: WorkUnitData) => boolean) | undefined,
    handle: (wu: WorkUnitData) => Promise<unknown>,
  ): void {
    if (this.subscribed) return;
    this.subscribed = true;

    eventBus.subscribe('workunit.status_changed', (payload: { workunit: WorkUnitData }) => {
      const wu = payload.workunit;
      if (filter && !filter(wu)) return;
      this.settled.track(handle(wu));
    });
  }

  /** 等待本实例已触发的全部在途事件链落定（测试用确定性信号，替代盲等轮询） */
  async waitForSettled(): Promise<void> {
    await this.settled.waitForSettled();
  }
}
