/**
 * StudioEventBus — 监听器上限（P9：启动 MaxListenersExceededWarning）。
 *
 * workunit.status_changed 的模块级订阅方已达 11 个（requirements/pmo 各 rollup、
 * ReviewDispatcher、InReviewInbox、RoleMemory、SkillUsageScan、Distill 等），
 * 每个 AgentLoop 实例再 +1——常态即超 EventEmitter 默认上限 10，属业务扇出
 * 而非泄漏。上限在构造时显式抬高，本测试锁定「超 10 订阅不告警、全部送达」。
 */
import { describe, it, expect, vi } from 'vitest';
import { StudioEventBus } from '../event-bus.js';

describe('StudioEventBus 监听器上限', () => {
  it('同一事件挂 15 个订阅不触发 MaxListenersExceededWarning 且全部送达', () => {
    const warnSpy = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const bus = new StudioEventBus();
    const seen: number[] = [];
    for (let i = 0; i < 15; i++) {
      bus.subscribe('workunit.status_changed', () => { seen.push(i); });
    }
    bus.publish('workunit.status_changed', { workunit: { id: 'wu-x' } });
    expect(seen).toHaveLength(15);
    const maxListenersWarnings = warnSpy.mock.calls.filter(args =>
      String(args[0]).includes('MaxListenersExceededWarning') || String(args[1]).includes('MaxListenersExceeded'),
    );
    expect(maxListenersWarnings).toHaveLength(0);
    warnSpy.mockRestore();
  });
});
