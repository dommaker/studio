// B4（2026-08-03 unattended-token-burn issue P0-2）：blocked 原因落盘（blockReason）
// #94：人工回复恢复时不再清零会话预算（sessionCount 保留，凭 metadata.sessionId 优先续用旧会话）
// 约定与 waiting-input.test.ts 一致：真实 FileStore（tmpdir）+ 真实 WorkUnitService
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitMetadata } from '../workunit.service.js';
import { scanTimedOutWorkUnits, MAX_TIMEOUT_RELEASES } from '../timeout-release.js';
import { resumeWaitingWorkUnit } from '../waiting-input.js';

let tmpDir: string;
let fileStore: FileStore;
let wuService: WorkUnitService;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'block-reason-test-'));
  fileStore = new FileStore(tmpDir);
  wuService = new WorkUnitService(fileStore);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function metaOf(wu: { metadata: string | null }): WorkUnitMetadata {
  return wu.metadata ? JSON.parse(wu.metadata) : {};
}

describe('B4: blockReason 落盘', () => {
  it('markMergeConflict → blocked + merge-conflict 原因', async () => {
    const wu = await wuService.create({ scope: '合并冲突任务', type: 'task', status: 'in_review' });
    await wuService.markMergeConflict(wu.id, ['a.ts', 'b.ts']);

    const after = (await wuService.getById(wu.id))!;
    expect(after.status).toBe('blocked');
    const meta = metaOf(after);
    expect(meta.blockReason).toContain('merge-conflict');
    expect(meta.mergeConflict).toBe(true);
    expect(meta.conflictFiles).toEqual(['a.ts', 'b.ts']);
  });

  it('blockForManualRelease → blocked + manual-release 原因', async () => {
    const wu = await wuService.create({ scope: '被释放任务', type: 'task', status: 'active', assigneeId: 'inst-1' });
    await wuService.blockForManualRelease(wu.id, 'terminate instance inst-1');

    const after = (await wuService.getById(wu.id))!;
    expect(after.status).toBe('blocked');
    expect(metaOf(after).blockReason).toBe('manual-release: terminate instance inst-1');
  });

  it('reviewRejected 连续 3 次 → blocked + review-rejected 原因（含最近拒绝理由）', async () => {
    const wu = await wuService.create({ scope: '被评审任务', type: 'task', status: 'unassigned' }); // #126：task 默认落 pending（不可认领），显式置 unassigned
    await wuService.claim(wu.id, 'inst-1');
    await wuService.transitionStatus(wu.id, 'in_review');
    await wuService.reviewRejected(wu.id, '第一次拒绝');
    await wuService.transitionStatus(wu.id, 'in_review');
    await wuService.reviewRejected(wu.id, '第二次拒绝');
    await wuService.transitionStatus(wu.id, 'in_review');
    const after = await wuService.reviewRejected(wu.id, '第三次：缺测试');

    expect(after.status).toBe('blocked');
    const meta = metaOf(after);
    expect(meta.blockReason).toContain('review-rejected x3');
    expect(meta.blockReason).toContain('第三次：缺测试');
  });

  it('reviewRejected 未达 3 次（回 active）不写 blockReason', async () => {
    const wu = await wuService.create({ scope: '被评审任务', type: 'task', status: 'unassigned' }); // #126：task 默认落 pending（不可认领），显式置 unassigned
    await wuService.claim(wu.id, 'inst-1');
    await wuService.transitionStatus(wu.id, 'in_review');
    const after = await wuService.reviewRejected(wu.id, '第一次拒绝');

    expect(after.status).toBe('active');
    expect(metaOf(after).blockReason).toBeUndefined();
  });

  it('超时释放达上限 → blocked + timeout 原因', async () => {
    const wu = await wuService.create({
      scope: '超时任务', type: 'task',
      status: 'unassigned', // #126：task 默认落 pending（不可认领），显式置 unassigned
      metadata: { timeoutReleaseCount: MAX_TIMEOUT_RELEASES - 1 },
    });
    await wuService.claim(wu.id, 'inst-1');
    await wuService.update(wu.id, { timeoutAt: new Date(Date.now() - 1000) });

    const handled = await scanTimedOutWorkUnits(fileStore);

    expect(handled).toBe(1);
    const after = (await wuService.getById(wu.id))!;
    expect(after.status).toBe('blocked');
    expect(metaOf(after).blockReason).toContain('timeout');
  });

  it('超时释放未达上限（回池）不写 blockReason', async () => {
    const wu = await wuService.create({ scope: '超时任务', type: 'task', status: 'unassigned' }); // #126：task 默认落 pending（不可认领），显式置 unassigned
    await wuService.claim(wu.id, 'inst-1');
    await wuService.update(wu.id, { timeoutAt: new Date(Date.now() - 1000) });

    await scanTimedOutWorkUnits(fileStore);

    const after = (await wuService.getById(wu.id))!;
    expect(after.status).toBe('unassigned');
    expect(metaOf(after).blockReason).toBeUndefined();
  });
});

describe('#176（决策 #57 D4）：blockedAt 死信计时基准落档', () => {
  it('transitionStatus → blocked 落 metadata.blockedAt', async () => {
    const wu = await wuService.create({ scope: '任务', type: 'task', status: 'active', assigneeId: 'inst-1' });

    await wuService.transitionStatus(wu.id, 'blocked');

    const meta = metaOf((await wuService.getById(wu.id))!);
    expect(typeof meta.blockedAt).toBe('string');
    expect(Math.abs(Date.now() - new Date(meta.blockedAt!).getTime())).toBeLessThan(10_000);
  });

  it('markMergeConflict → blocked 落 blockedAt', async () => {
    const wu = await wuService.create({ scope: '合并冲突任务', type: 'task', status: 'in_review' });
    await wuService.markMergeConflict(wu.id, ['a.ts']);

    expect(typeof metaOf((await wuService.getById(wu.id))!).blockedAt).toBe('string');
  });

  it('blockForManualRelease → blocked 落 blockedAt', async () => {
    const wu = await wuService.create({ scope: '被释放任务', type: 'task', status: 'active', assigneeId: 'inst-1' });
    await wuService.blockForManualRelease(wu.id, 'terminate instance inst-1');

    expect(typeof metaOf((await wuService.getById(wu.id))!).blockedAt).toBe('string');
  });

  it('reviewRejected 连续 3 次 → blocked 落 blockedAt', async () => {
    const wu = await wuService.create({ scope: '被评审任务', type: 'task', status: 'unassigned' });
    await wuService.claim(wu.id, 'inst-1');
    for (const reason of ['一', '二', '三']) {
      await wuService.transitionStatus(wu.id, 'in_review');
      await wuService.reviewRejected(wu.id, reason);
    }

    const after = (await wuService.getById(wu.id))!;
    expect(after.status).toBe('blocked');
    expect(typeof metaOf(after).blockedAt).toBe('string');
  });

  it('复活后再次 blocked → blockedAt 刷新为新时刻', async () => {
    const wu = await wuService.create({ scope: '任务', type: 'task', status: 'active', assigneeId: 'inst-1' });
    await wuService.transitionStatus(wu.id, 'blocked');
    await wuService.update(wu.id, {
      metadata: { waitingForInput: true, blockedAt: new Date(Date.now() - 3600_000).toISOString() },
    });
    await resumeWaitingWorkUnit(wu.id, '继续', fileStore);

    await wuService.transitionStatus(wu.id, 'blocked');

    const meta = metaOf((await wuService.getById(wu.id))!);
    expect(Math.abs(Date.now() - new Date(meta.blockedAt!).getTime())).toBeLessThan(10_000);
  });
});

describe('B4+#94: 人工恢复时的清理', () => {
  it('resumeWaitingWorkUnit 清除 blockReason、保留 sessionCount（复活优先续用旧会话，不再清零预算）', async () => {
    const wu = await wuService.create({ scope: '挂起任务', type: 'task', status: 'active', assigneeId: 'inst-1' });
    await wuService.transitionStatus(wu.id, 'blocked');
    await wuService.update(wu.id, {
      metadata: {
        waitingForInput: true,
        waitingQuestion: '会话超限，是否继续？',
        waitingSince: new Date().toISOString(),
        waitingReminded: false,
        blockReason: 'need-input: 会话超限，是否继续？',
        sessionCount: 2,
      },
    });

    const resumed = await resumeWaitingWorkUnit(wu.id, '继续执行', fileStore);

    expect(resumed).toBe(true);
    const after = (await wuService.getById(wu.id))!;
    expect(after.status).toBe('active');
    const meta = metaOf(after);
    expect(meta.blockReason).toBeUndefined();
    expect(meta.sessionCount).toBe(2);
    expect(meta.waitingForInput).toBe(false);
    expect(meta.pendingReplies).toEqual(['继续执行']);
  });
});
