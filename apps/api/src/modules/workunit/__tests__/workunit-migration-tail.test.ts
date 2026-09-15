// #550：迁移类写路径统一落库尾部（persistSnapshot）的不变式单点断言——
// 「校验 → 快照 → 事件 → 父聚合」尾部对全部迁移路径生效，新增迁移入口不再需要抄尾巴。
// 覆盖不变式：状态落锚（closedAt/completedAt/blockedAt）、workunit.status_changed 发布、
// 父状态聚合、reopen（closed → unassigned）closedAt 清除 + thaw。
// 约定：真实 FileStore（tmpdir）+ 真实 WorkUnitService。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore, eventBus, type WorkUnitSnapshot } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitData } from '../workunit.service.js';
import { parseWuMetadata } from '../wu-metadata.js';

let tmpDir: string;
let fileStore: FileStore;
let wuService: WorkUnitService;
let statusEvents: WorkUnitData[];
let statusHandler: (payload: { workunit: WorkUnitData }) => void;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-migration-tail-'));
  process.env.STUDIO_EVENTS_FILE = path.join(tmpDir, 'studio-events.jsonl');
  fileStore = new FileStore(tmpDir);
  wuService = new WorkUnitService(fileStore);
  statusEvents = [];
  statusHandler = (payload) => { statusEvents.push(payload.workunit); };
  eventBus.subscribe('workunit.status_changed', statusHandler);
});

afterEach(() => {
  eventBus.unsubscribe('workunit.status_changed', statusHandler);
  delete process.env.STUDIO_EVENTS_FILE;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function snapshotOf(id: string): Promise<WorkUnitSnapshot> {
  return (await fileStore.getIndex()).find(s => s.id === id)!;
}

const flushAsync = () => new Promise(r => setTimeout(r, 50));

/** 关闭路径不变式：closedAt = completedAt 同刻落锚 + status_changed(closed) 已广播 */
async function expectClosedInvariants(wuId: string) {
  const snap = await snapshotOf(wuId);
  expect(snap.status).toBe('closed');
  expect(typeof snap.closedAt).toBe('string');
  expect(snap.closedAt).toBe(snap.completedAt);
  expect(statusEvents.some(e => e.id === wuId && e.status === 'closed')).toBe(true);
}

/** blocked 路径不变式：metadata.blockedAt 死信计时锚落档 + status_changed(blocked) 已广播 */
async function expectBlockedInvariants(wuId: string) {
  const snap = await snapshotOf(wuId);
  expect(snap.status).toBe('blocked');
  expect(typeof parseWuMetadata(snap.metadata).blockedAt).toBe('string');
  expect(statusEvents.some(e => e.id === wuId && e.status === 'blocked')).toBe(true);
}

describe('迁移类写路径统一尾部（#550）：不变式一处断言，全路径生效', () => {
  it('transitionStatus → closed', async () => {
    const wu = await wuService.create({ scope: '手工关闭', type: 'task', status: 'active' });
    statusEvents.length = 0;
    await wuService.transitionStatus(wu.id, 'closed');
    await expectClosedInvariants(wu.id);
  });

  it('close() → closed', async () => {
    const wu = await wuService.create({ scope: '系统关闭', type: 'task', status: 'active' });
    statusEvents.length = 0;
    await wuService.close(wu.id, { reason: '执行超过 2.5h', closedBy: 'total-time-kill' });
    await expectClosedInvariants(wu.id);
  });

  it('transitionStatus → blocked：blockedAt 落锚', async () => {
    const wu = await wuService.create({ scope: '挂起', type: 'task', status: 'active' });
    statusEvents.length = 0;
    await wuService.transitionStatus(wu.id, 'blocked');
    await expectBlockedInvariants(wu.id);
  });

  it('markMergeConflict → blocked：blockedAt 落锚 + 冲突 metadata 保留', async () => {
    const wu = await wuService.create({ scope: '合并冲突', type: 'task', status: 'active' });
    statusEvents.length = 0;
    await wuService.markMergeConflict(wu.id, ['a.ts', 'b.ts']);
    await expectBlockedInvariants(wu.id);
    const meta = parseWuMetadata((await snapshotOf(wu.id)).metadata);
    expect(meta.mergeConflict).toBe(true);
    expect(meta.conflictFiles).toEqual(['a.ts', 'b.ts']);
  });

  it('blockForManualRelease → blocked：blockedAt 落锚 + assigneeId/claimedAt 清空 + manualRelease 留痕', async () => {
    const wu = await wuService.create({ scope: '转人工', type: 'task', status: 'unassigned' });
    await wuService.claim(wu.id, 'inst-1');
    statusEvents.length = 0;
    await wuService.blockForManualRelease(wu.id, 'terminate instance inst-1');
    await expectBlockedInvariants(wu.id);
    const snap = await snapshotOf(wu.id);
    expect(snap.assigneeId).toBeNull();
    expect(snap.claimedAt).toBeNull();
    expect(parseWuMetadata(snap.metadata).manualRelease).toBe(true);
  });

  it('blockForAllUnfit → blocked：blockedAt 落锚', async () => {
    const wu = await wuService.create({ scope: '全员不适任', type: 'task', status: 'unassigned' });
    statusEvents.length = 0;
    await wuService.blockForAllUnfit(wu.id, 'all-unfit: 频道成员均不适任');
    await expectBlockedInvariants(wu.id);
  });

  it('reviewRejected 连续 3 次 → blocked：blockedAt 落锚', async () => {
    const wu = await wuService.create({ scope: '连续打回', type: 'task', status: 'active' });
    for (let i = 0; i < 3; i++) {
      await wuService.transitionStatus(wu.id, 'in_review');
      statusEvents.length = 0;
      await wuService.reviewRejected(wu.id, `第 ${i + 1} 次打回`);
    }
    await expectBlockedInvariants(wu.id);
  });

  it('父聚合对全部迁移路径生效（fire-and-forget，同 transitionStatus 先例）', async () => {
    // close() 路径：全子 closed → 父 closed
    const parentA = await wuService.create({ scope: '父A', type: 'task', status: 'active' });
    const childA = await wuService.create({ scope: '子A', type: 'task', status: 'active', parentId: parentA.id });
    await wuService.close(childA.id, { reason: '系统关闭', closedBy: 'total-time-kill' });
    await flushAsync();
    expect((await snapshotOf(parentA.id)).status).toBe('closed');

    // blocked 路径（blockForManualRelease 代表语义方法）：有子 blocked → 父 blocked
    const parentB = await wuService.create({ scope: '父B', type: 'task', status: 'unassigned' });
    const childB = await wuService.create({ scope: '子B', type: 'task', status: 'unassigned', parentId: parentB.id });
    await wuService.blockForManualRelease(childB.id, 'terminate');
    await flushAsync();
    expect((await snapshotOf(parentB.id)).status).toBe('blocked');
  });

  it('reopen（closed → unassigned）：closedAt 清除 + thaw 解冻触发', async () => {
    const thawSpy = vi.spyOn(fileStore, 'thawWorkUnitMessages');
    const wu = await wuService.create({ scope: '重开', type: 'task', status: 'active' });
    await wuService.transitionStatus(wu.id, 'closed');
    expect((await snapshotOf(wu.id)).closedAt).toBeTruthy();

    await wuService.transitionStatus(wu.id, 'unassigned');

    const snap = await snapshotOf(wu.id);
    expect(snap.status).toBe('unassigned');
    expect(snap.closedAt).toBeNull();
    expect(thawSpy).toHaveBeenCalledWith(wu.id);
    thawSpy.mockRestore();
  });
});
