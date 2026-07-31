// 2026-07 PMO-flow UX（§4 terminate 语义修正）：WorkUnitService.blockForManualRelease
// 覆盖：active/unassigned → blocked（assigneeId/claimedAt 清空 + manualRelease 留痕 + 既有 metadata 保留）、
//       终态（done/closed）不动、WU 不存在抛错。
// 模式同 workunit.service.test.ts：真实 FileStore（tmpdir）+ 真实 WorkUnitService。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitMetadata } from '../workunit.service.js';

describe('WorkUnitService.blockForManualRelease（2026-07 §4）', () => {
  let tmpDir: string;
  let fileStore: FileStore;
  let wuService: WorkUnitService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-manual-release-'));
    fileStore = new FileStore(tmpDir);
    wuService = new WorkUnitService(fileStore);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('active WU → blocked，assigneeId/claimedAt 清空，manualRelease 留痕且既有 metadata 保留', async () => {
    const wu = await wuService.create({
      scope: '被强制释放的任务', type: 'task', status: 'active', assigneeId: 'inst-1',
      metadata: { title: '登录页重构' },
    });

    const result = await wuService.blockForManualRelease(wu.id, 'terminate instance inst-1');

    expect(result.status).toBe('blocked');
    expect(result.assigneeId).toBeNull();
    expect(result.claimedAt).toBeNull();
    const meta = JSON.parse(result.metadata!) as WorkUnitMetadata;
    expect(meta.manualRelease).toBe(true);
    expect(meta.manualReleaseReason).toBe('terminate instance inst-1');
    expect(meta.title).toBe('登录页重构');

    // 持久化一致
    const persisted = (await wuService.getById(wu.id))!;
    expect(persisted.status).toBe('blocked');
    expect(persisted.assigneeId).toBeNull();
  });

  it('unassigned WU（unclaim 后状态）→ blocked（unassigned→blocked 不在 VALID_TRANSITIONS，语义方法直写）', async () => {
    const wu = await wuService.create({ scope: '待认领任务', type: 'task', status: 'unassigned' });

    // 状态机拒绝 unassigned → blocked
    await expect(wuService.transitionStatus(wu.id, 'blocked')).rejects.toThrow('Invalid status transition');

    const result = await wuService.blockForManualRelease(wu.id, 'terminate instance inst-1');
    expect(result.status).toBe('blocked');

    // blocked WU 不可被 claim（loop 认领集合只含 unassigned）——terminate 后不回弹
    await expect(wuService.claim(wu.id, 'inst-2')).rejects.toThrow();
  });

  it('终态（done/closed）WU 不动——工作已收口，无可释放', async () => {
    const doneWu = await wuService.create({ scope: '已完成任务', type: 'task', status: 'unassigned' });
    await wuService.claim(doneWu.id, 'inst-1');
    await wuService.transitionStatus(doneWu.id, 'in_review');
    await wuService.transitionStatus(doneWu.id, 'done');
    const before = (await wuService.getById(doneWu.id))!;

    const result = await wuService.blockForManualRelease(doneWu.id, 'terminate instance inst-1');

    expect(result.status).toBe('done');
    expect(result.completedAt?.toISOString()).toBe(before.completedAt?.toISOString());
    const meta = JSON.parse(result.metadata ?? '{}') as WorkUnitMetadata;
    expect(meta.manualRelease).toBeUndefined();
  });

  it('WU 不存在 → 抛错', async () => {
    await expect(wuService.blockForManualRelease('wu-ghost', 'terminate instance inst-1'))
      .rejects.toThrow('WorkUnit not found');
  });
});
