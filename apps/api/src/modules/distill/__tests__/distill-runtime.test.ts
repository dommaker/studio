/**
 * distill-runtime (#143) — 运行时装配测试
 *
 * 覆盖：getDistillService 懒单例（同一实例）；initDistillLoop 订阅幂等
 * （多次 init 不重复订阅，done 事件只触发一次 maybePropose，非 done 不触发）。
 * maybePropose 用 spy 打桩——本测试不碰真实知识库与数据区。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { eventBus } from '@dommaker/studio-shared';
import { getDistillService, initDistillLoop } from '../distill-runtime.js';

afterEach(() => {
  eventBus.unsubscribeAll?.('workunit.status_changed');
  vi.restoreAllMocks();
});

describe('distill-runtime 装配', () => {
  it('getDistillService 懒单例：两次调用同一实例', () => {
    expect(getDistillService()).toBe(getDistillService());
  });

  it('initDistillLoop 订阅 workunit.status_changed → done；非 done 忽略；重复 init 不重复订阅', () => {
    const service = initDistillLoop();
    initDistillLoop(); // 幂等
    const spy = vi.spyOn(service, 'maybePropose').mockResolvedValue(undefined);

    eventBus.publish('workunit.status_changed', { workunit: { id: 'wu-1', status: 'in_progress' } });
    expect(spy).not.toHaveBeenCalled();

    eventBus.publish('workunit.status_changed', { workunit: { id: 'wu-1', status: 'done' } });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ workUnitId: 'wu-1' });
  });
});
