/**
 * #209 smell 4：WuLeaseTracker 单测（从 AgentLoop 迁出的租约/fencing 内聚组）。
 * 假 deps 直测 Tracker；端到端 fencing（recordResult 路径）在
 * __tests__/agent-loop-lease.test.ts，心跳本体在 __tests__/lease-heartbeat.test.ts。
 */
import { describe, it, expect, vi } from 'vitest';
import type { FileStore } from '@dommaker/studio-shared';
import { WuLeaseTracker } from '../wu-lease';

interface Snapshot {
  id: string;
  assigneeId?: string | null;
  claimedAt?: string;
  status?: string;
}

function makeTracker(index: Snapshot[] = [], assigneeId: string | null = 'inst-1') {
  const fileStore = {
    getIndex: vi.fn(async () => index.map(s => ({ ...s }))),
  } as unknown as FileStore;
  const transitionStatus = vi.fn(async () => undefined);
  const stopProcessGroup = vi.fn(async () => undefined);
  const tracker = new WuLeaseTracker({
    fileStore,
    getAssigneeId: () => assigneeId,
    getCurrentExecutionId: () => 'exec-1',
    stopProcessGroup,
    transitionStatus,
  });
  return { tracker, fileStore, transitionStatus, stopProcessGroup };
}

/** 直探私有 lease（测试同款 cast 约定） */
type LeaseInternals = { lease: { wuId: string; claimedAt: string } | null };

function armLease(tracker: WuLeaseTracker, wuId: string, claimedAt: string) {
  (tracker as unknown as LeaseInternals).lease = { wuId, claimedAt, stop: vi.fn() };
}

describe('WuLeaseTracker.stillHolds（fencing 双比对）', () => {
  it('assigneeId + claimedAt 均一致 -> 持有', async () => {
    const { tracker } = makeTracker([{ id: 'wu-1', assigneeId: 'inst-1', claimedAt: 't1' }]);
    armLease(tracker, 'wu-1', 't1');
    expect(await tracker.stillHolds('wu-1')).toBe(true);
  });

  it('claimedAt 换代（易主后重新认领）-> 失持', async () => {
    const { tracker } = makeTracker([{ id: 'wu-1', assigneeId: 'inst-2', claimedAt: 't2' }]);
    armLease(tracker, 'wu-1', 't1');
    expect(await tracker.stillHolds('wu-1')).toBe(false);
  });

  it('快照缺失 -> 失持；无租约轨道/非本 WU -> 不拦（返回 true，既有行为）', async () => {
    const { tracker } = makeTracker([]);
    expect(await tracker.stillHolds('wu-1')).toBe(true); // 无轨道
    armLease(tracker, 'wu-other', 't1');
    expect(await tracker.stillHolds('wu-1')).toBe(true); // 非本 WU
  });
});

describe('WuLeaseTracker.transitionIfHeld', () => {
  it('持有有效 -> 执行真实迁移', async () => {
    const { tracker, transitionStatus } = makeTracker([{ id: 'wu-1', assigneeId: 'inst-1', claimedAt: 't1' }]);
    armLease(tracker, 'wu-1', 't1');
    expect(await tracker.transitionIfHeld('wu-1', 'in_review')).toBe(true);
    expect(transitionStatus).toHaveBeenCalledWith('wu-1', 'in_review');
  });

  it('易主 -> 不迁移 + 杀自身进程组 + 停轨道', async () => {
    const { tracker, transitionStatus, stopProcessGroup } = makeTracker([{ id: 'wu-1', assigneeId: 'inst-2', claimedAt: 't2' }]);
    armLease(tracker, 'wu-1', 't1');
    expect(await tracker.transitionIfHeld('wu-1', 'in_review')).toBe(false);
    expect(transitionStatus).not.toHaveBeenCalled();
    expect(stopProcessGroup).toHaveBeenCalledWith('exec-1');
    expect((tracker as unknown as LeaseInternals).lease).toBeNull();
  });
});

describe('WuLeaseTracker.releaseIfForfeited', () => {
  it('WU 离开 active -> 停轨道', async () => {
    const { tracker } = makeTracker([{ id: 'wu-1', assigneeId: 'inst-1', claimedAt: 't1', status: 'in_review' }]);
    armLease(tracker, 'wu-1', 't1');
    await tracker.releaseIfForfeited('wu-1');
    expect((tracker as unknown as LeaseInternals).lease).toBeNull();
  });

  it('仍 active 且持有 -> 保留轨道；非本 WU -> 不动', async () => {
    const a = makeTracker([{ id: 'wu-1', assigneeId: 'inst-1', claimedAt: 't1', status: 'active' }]);
    armLease(a.tracker, 'wu-1', 't1');
    await a.tracker.releaseIfForfeited('wu-1');
    expect((a.tracker as unknown as LeaseInternals).lease).not.toBeNull();

    const b = makeTracker([]);
    armLease(b.tracker, 'wu-1', 't1');
    await b.tracker.releaseIfForfeited('wu-other');
    expect((b.tracker as unknown as LeaseInternals).lease).not.toBeNull();
  });
});
