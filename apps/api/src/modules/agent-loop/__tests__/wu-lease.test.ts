/** WuLeaseTracker 窄 deps 单测；租约通过 ensure() 建立，经 has() 观察。 */
import { describe, it, expect, vi } from 'vitest';
import type { FileStore } from '@dommaker/studio-shared';
import { WuLeaseTracker } from '../wu-lease';
import type { WorkUnitData } from '../../workunit/index.js';

interface Snapshot {
  id: string;
  assigneeId?: string | null;
  claimedAt?: string;
  status?: string;
}

const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-01-01T00:00:01.000Z';

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

function armLease(tracker: WuLeaseTracker, wuId: string, claimedAt: string) {
  tracker.ensure({
    id: wuId, parentId: null, type: 'task', scope: 'lease', assigneeId: 'inst-1',
    status: 'active', failureType: null, retryCount: 0, timeoutAt: null, channelId: null,
    projectPath: null, metadata: null, createdAt: new Date(), updatedAt: new Date(),
    claimedAt: new Date(claimedAt), completedAt: null,
  } satisfies WorkUnitData);
  tracker.has(wuId);
}

describe('WuLeaseTracker.stillHolds（fencing 双比对）', () => {
  it('assigneeId + claimedAt 均一致 -> 持有', async () => {
    const { tracker } = makeTracker([{ id: 'wu-1', assigneeId: 'inst-1', claimedAt: T1 }]);
    armLease(tracker, 'wu-1', T1);
    expect(await tracker.stillHolds('wu-1')).toBe(true);
    tracker.stop();
  });

  it('claimedAt 换代（易主后重新认领）-> 失持', async () => {
    const { tracker } = makeTracker([{ id: 'wu-1', assigneeId: 'inst-2', claimedAt: T2 }]);
    armLease(tracker, 'wu-1', T1);
    expect(await tracker.stillHolds('wu-1')).toBe(false);
    tracker.stop();
  });

  it('快照缺失 -> 失持；无租约轨道/非本 WU -> 不拦（返回 true，既有行为）', async () => {
    const { tracker } = makeTracker([]);
    expect(await tracker.stillHolds('wu-1')).toBe(true);
    armLease(tracker, 'wu-other', T1);
    expect(await tracker.stillHolds('wu-1')).toBe(true);
    tracker.stop();
  });
});

describe('WuLeaseTracker.transitionIfHeld', () => {
  it('持有有效 -> 执行真实迁移', async () => {
    const { tracker, transitionStatus } = makeTracker([{ id: 'wu-1', assigneeId: 'inst-1', claimedAt: T1 }]);
    armLease(tracker, 'wu-1', T1);
    expect(await tracker.transitionIfHeld('wu-1', 'in_review')).toBe(true);
    expect(transitionStatus).toHaveBeenCalledWith('wu-1', 'in_review');
    tracker.stop();
  });

  it('易主 -> 不迁移 + 杀自身进程组 + 停轨道', async () => {
    const { tracker, transitionStatus, stopProcessGroup } = makeTracker([{ id: 'wu-1', assigneeId: 'inst-2', claimedAt: T2 }]);
    armLease(tracker, 'wu-1', T1);
    expect(await tracker.transitionIfHeld('wu-1', 'in_review')).toBe(false);
    expect(transitionStatus).not.toHaveBeenCalled();
    expect(stopProcessGroup).toHaveBeenCalledWith('exec-1');
    expect(tracker.has()).toBe(false);
  });
});

describe('WuLeaseTracker.releaseIfForfeited', () => {
  it('WU 离开 active -> 停轨道', async () => {
    const { tracker } = makeTracker([{ id: 'wu-1', assigneeId: 'inst-1', claimedAt: T1, status: 'in_review' }]);
    armLease(tracker, 'wu-1', T1);
    await tracker.releaseIfForfeited('wu-1');
    expect(tracker.has()).toBe(false);
  });

  it('仍 active 且持有 -> 保留轨道；非本 WU -> 不动', async () => {
    const a = makeTracker([{ id: 'wu-1', assigneeId: 'inst-1', claimedAt: T1, status: 'active' }]);
    armLease(a.tracker, 'wu-1', T1);
    await a.tracker.releaseIfForfeited('wu-1');
    expect(a.tracker.has('wu-1')).toBe(true);
    a.tracker.stop();

    const b = makeTracker([]);
    armLease(b.tracker, 'wu-1', T1);
    await b.tracker.releaseIfForfeited('wu-other');
    expect(b.tracker.has('wu-1')).toBe(true);
    b.tracker.stop();
  });
});
