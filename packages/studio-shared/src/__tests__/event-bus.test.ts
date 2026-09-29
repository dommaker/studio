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

describe('StudioEventBus 精确匹配路径容错', () => {
  it('单个订阅者同步抛错：不炸进发布方调用栈，其余 handler 照常送达', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = new StudioEventBus();
    const seen: string[] = [];
    bus.subscribe('channel.message_sent', () => { throw new Error('boom'); });
    bus.subscribe('channel.message_sent', () => { seen.push('second'); });

    expect(() => bus.publish('channel.message_sent', { id: 'm-1' })).not.toThrow();
    expect(seen).toEqual(['second']);
    expect(errSpy).toHaveBeenCalledOnce();
    expect(String(errSpy.mock.calls[0][0])).toContain('channel.message_sent');
    errSpy.mockRestore();
  });

  it('once 订阅者抛错同样被隔离，且一次性语义不受影响', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = new StudioEventBus();
    const seen: string[] = [];
    bus.once('evolution.applied', () => { throw new Error('boom'); });
    bus.subscribe('evolution.applied', () => { seen.push('hit'); });

    expect(() => bus.publish('evolution.applied', {})).not.toThrow();
    expect(() => bus.publish('evolution.applied', {})).not.toThrow();
    expect(seen).toEqual(['hit', 'hit']);
    expect(errSpy).toHaveBeenCalledOnce();
    errSpy.mockRestore();
  });
});
