/**
 * rollup tests — REQ 状态汇总的事件接线（vision §5.3）
 *
 * #457（perf，架构评审第四轮候选 9）：消费侧改 per-req memo + 去抖（照 #410
 * pmo/progress-rollup 先例）——事件负载（snapshotToData 全量快照）喂 memo，
 * 稳态零存储读；冷启动首个评估回源一次补齐兄弟 WU；同 req 去抖窗口内连续事件
 * 合并为一次评估。行为口径不变：评估仍走 svc.maybeRollUpToDone（内部新鲜
 * get(reqId) 判 done/archived/别名），仅兄弟快照来源从每事件全量索引读改为 memo。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { eventBus } from '@dommaker/studio-shared';
import {
  initRequirementRollup,
  waitForRequirementRollupSettled,
  rollupTiming,
} from '../rollup.js';
import type { RequirementService } from '../requirement.service.js';

type MockService = RequirementService & {
  maybeRollUpToDone: ReturnType<typeof vi.fn>;
  listWorkUnitSnapshots: ReturnType<typeof vi.fn>;
};

function makeService(): MockService {
  return {
    maybeRollUpToDone: vi.fn().mockResolvedValue(true),
    listWorkUnitSnapshots: vi.fn().mockResolvedValue([]),
  } as unknown as MockService;
}

/** 评估入参 snapshots（maybeRollUpToDone 第二参）中的 wu id 清单 */
function evaluatedWuIds(svc: MockService, callIndex: number): string[] {
  const snapshots = svc.maybeRollUpToDone.mock.calls[callIndex]![1] as Array<{ id: string }>;
  return snapshots.map(s => s.id).sort();
}

afterEach(() => {
  eventBus.unsubscribeAll?.('workunit.status_changed');
  eventBus.unsubscribeAll?.('workunit.created');
  rollupTiming.debounceMs = 0;
});

rollupTiming.debounceMs = 0;

describe('initRequirementRollup（#457 per-req memo + 去抖）', () => {
  it('status_changed 带 reqId → 冷启动回源一次后按 memo 评估', async () => {
    const svc = makeService();
    const off = initRequirementRollup(svc);
    eventBus.publish('workunit.status_changed', {
      workunit: { id: 'wu-1', reqId: 'REQ-0001', status: 'done' },
    });
    await waitForRequirementRollupSettled();

    expect(svc.listWorkUnitSnapshots).toHaveBeenCalledTimes(1);
    expect(svc.listWorkUnitSnapshots).toHaveBeenCalledWith('REQ-0001');
    expect(svc.maybeRollUpToDone).toHaveBeenCalledTimes(1);
    expect(svc.maybeRollUpToDone.mock.calls[0]![0]).toBe('REQ-0001');
    expect(evaluatedWuIds(svc, 0)).toEqual(['wu-1']);
    off();
  });

  it('稳态（memo 温热）不再回源', async () => {
    const svc = makeService();
    const off = initRequirementRollup(svc);
    eventBus.publish('workunit.status_changed', {
      workunit: { id: 'wu-1', reqId: 'REQ-0001', status: 'active' },
    });
    await waitForRequirementRollupSettled();
    eventBus.publish('workunit.status_changed', {
      workunit: { id: 'wu-1', reqId: 'REQ-0001', status: 'done' },
    });
    await waitForRequirementRollupSettled();

    expect(svc.listWorkUnitSnapshots).toHaveBeenCalledTimes(1);
    expect(svc.maybeRollUpToDone).toHaveBeenCalledTimes(2);
    off();
  });

  it('去抖：窗口内同 req 连续事件合并为一次评估', async () => {
    const svc = makeService();
    rollupTiming.debounceMs = 30;
    const off = initRequirementRollup(svc);
    eventBus.publish('workunit.status_changed', {
      workunit: { id: 'wu-1', reqId: 'REQ-0001', status: 'done' },
    });
    eventBus.publish('workunit.status_changed', {
      workunit: { id: 'wu-2', reqId: 'REQ-0001', status: 'done' },
    });
    eventBus.publish('workunit.status_changed', {
      workunit: { id: 'wu-3', reqId: 'REQ-0001', status: 'done' },
    });
    await waitForRequirementRollupSettled();

    expect(svc.maybeRollUpToDone).toHaveBeenCalledTimes(1);
    expect(evaluatedWuIds(svc, 0)).toEqual(['wu-1', 'wu-2', 'wu-3']);
    off();
  });

  it('created 只喂 memo 不触发评估；后续评估计入 created 兄弟', async () => {
    const svc = makeService();
    const off = initRequirementRollup(svc);
    eventBus.publish('workunit.created', {
      workunit: { id: 'wu-x', reqId: 'REQ-0001', status: 'unassigned' },
    });
    await new Promise(r => setTimeout(r, 20));
    expect(svc.maybeRollUpToDone).not.toHaveBeenCalled();

    eventBus.publish('workunit.status_changed', {
      workunit: { id: 'wu-1', reqId: 'REQ-0001', status: 'done' },
    });
    await waitForRequirementRollupSettled();
    expect(svc.maybeRollUpToDone).toHaveBeenCalledTimes(1);
    expect(evaluatedWuIds(svc, 0)).toEqual(['wu-1', 'wu-x']);
    off();
  });

  it('冷启动回源补齐未发事件的兄弟 WU（不覆盖事件喂入的更新状态）', async () => {
    const svc = makeService();
    svc.listWorkUnitSnapshots.mockResolvedValue([
      { id: 'wu-old', reqId: 'REQ-0001', status: 'done' },
      // 存储读早于 wu-1 的 done 落盘（竞态窗口）——事件喂入的 done 不得被回源旧态覆盖
      { id: 'wu-1', reqId: 'REQ-0001', status: 'active' },
    ]);
    const off = initRequirementRollup(svc);
    eventBus.publish('workunit.status_changed', {
      workunit: { id: 'wu-1', reqId: 'REQ-0001', status: 'done' },
    });
    await waitForRequirementRollupSettled();

    const snapshots = svc.maybeRollUpToDone.mock.calls[0]![1] as Array<{ id: string; status: string }>;
    expect(snapshots.find(s => s.id === 'wu-old')).toBeTruthy();
    expect(snapshots.find(s => s.id === 'wu-1')!.status).toBe('done');
    off();
  });

  it('rebind：WU 换 req 后从旧 memo 移除、计入新 memo', async () => {
    const svc = makeService();
    const off = initRequirementRollup(svc);
    eventBus.publish('workunit.status_changed', {
      workunit: { id: 'wu-1', reqId: 'REQ-0001', status: 'active' },
    });
    await waitForRequirementRollupSettled();

    // wu-1 改挂 REQ-0002
    eventBus.publish('workunit.status_changed', {
      workunit: { id: 'wu-1', reqId: 'REQ-0002', status: 'done' },
    });
    await waitForRequirementRollupSettled();
    expect(svc.maybeRollUpToDone.mock.calls[1]![0]).toBe('REQ-0002');
    expect(evaluatedWuIds(svc, 1)).toEqual(['wu-1']);

    // REQ-0001 后续评估不再计入 wu-1
    eventBus.publish('workunit.status_changed', {
      workunit: { id: 'wu-2', reqId: 'REQ-0001', status: 'done' },
    });
    await waitForRequirementRollupSettled();
    expect(svc.maybeRollUpToDone.mock.calls[2]![0]).toBe('REQ-0001');
    expect(evaluatedWuIds(svc, 2)).toEqual(['wu-2']);
    off();
  });

  it('ignores events without reqId', async () => {
    const svc = makeService();
    const off = initRequirementRollup(svc);
    eventBus.publish('workunit.status_changed', { workunit: { id: 'wu-2', reqId: null } });
    eventBus.publish('workunit.status_changed', { workunit: { id: 'wu-3' } });
    await new Promise(r => setTimeout(r, 20));
    expect(svc.maybeRollUpToDone).not.toHaveBeenCalled();
    expect(svc.listWorkUnitSnapshots).not.toHaveBeenCalled();
    off();
  });

  it('unbind function detaches the handler', async () => {
    const svc = makeService();
    const off = initRequirementRollup(svc);
    off();
    eventBus.publish('workunit.status_changed', {
      workunit: { id: 'wu-4', reqId: 'REQ-0002', status: 'done' },
    });
    await new Promise(r => setTimeout(r, 20));
    expect(svc.maybeRollUpToDone).not.toHaveBeenCalled();
  });

  it('swallows evaluation errors (best-effort)', async () => {
    const svc = makeService();
    svc.maybeRollUpToDone.mockRejectedValue(new Error('boom'));
    const off = initRequirementRollup(svc);
    expect(() => eventBus.publish('workunit.status_changed', {
      workunit: { id: 'wu-1', reqId: 'REQ-0003', status: 'done' },
    })).not.toThrow();
    await waitForRequirementRollupSettled();
    off();
  });

  it('swallows resource errors (best-effort)', async () => {
    const svc = makeService();
    svc.listWorkUnitSnapshots.mockRejectedValue(new Error('io boom'));
    const off = initRequirementRollup(svc);
    expect(() => eventBus.publish('workunit.status_changed', {
      workunit: { id: 'wu-1', reqId: 'REQ-0004', status: 'done' },
    })).not.toThrow();
    await waitForRequirementRollupSettled();
    expect(svc.maybeRollUpToDone).not.toHaveBeenCalled();
    off();
  });
});
