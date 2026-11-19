import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileStore } from '@dommaker/studio-shared';
import { workUnitSchema } from '@dommaker/studio-contract';
import { WorkUnitService } from '../workunit-review.js';
import { toWorkUnitWire } from '../workunit-crud.js';
import { resumeWaitingWorkUnit } from '../waiting-input.js';
import { MAX_TIMEOUT_RELEASES, scanTimedOutWorkUnits } from '../timeout-release.js';

let tmpDir: string;
let store: FileStore;
let service: WorkUnitService;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assignment-lifecycle-'));
  store = new FileStore(tmpDir);
  service = new WorkUnitService(store);
});

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('WorkUnit Assignment 执行轮次', () => {
  it('claim 创建 queued 轮次，公开读模型只暴露一个当前执行', async () => {
    const created = await service.create({ scope: '保留执行历史', type: 'task', status: 'unassigned' });

    const claimed = await service.claim(created.id, 'instance-1');
    const read = await service.getById(created.id);

    expect(claimed.execution?.current).toMatchObject({
      workUnitId: created.id,
      attempt: 1,
      status: 'queued',
      previousAssignmentId: null,
    });
    expect(read?.execution?.assignments).toHaveLength(1);
    expect(read?.execution?.current?.id).toBe(claimed.execution?.current?.id);
    expect(workUnitSchema.parse(toWorkUnitWire(read!)).execution?.current?.status).toBe('queued');
    await store.rebuildIndex();
    expect((await service.getById(created.id))?.execution?.current?.id).toBe(claimed.execution?.current?.id);
    await expect(service.claim(created.id, 'instance-2')).rejects.toThrow('Claim failed');
    expect((await service.getById(created.id))?.execution?.assignments).toHaveLength(1);
  });

  it('unclaim 后恢复执行保留旧轮次并链接新 Assignment', async () => {
    const created = await service.create({ scope: '进程恢复', type: 'task', status: 'unassigned' });
    const first = await service.claim(created.id, 'instance-old');

    await service.unclaim(created.id);
    const recovered = await service.claim(created.id, 'instance-new');

    expect(recovered.execution?.current).toMatchObject({
      attempt: 2,
      status: 'queued',
      previousAssignmentId: first.execution?.current?.id,
    });
    expect(recovered.execution?.assignments[0].status).toBe('cancelled');
    expect(recovered.execution?.assignments.filter(a => ['queued', 'running'].includes(a.status))).toHaveLength(1);
  });

  it('关闭 WU 会取消未决 Assignment，历史仍可读取', async () => {
    const created = await service.create({ scope: '关闭执行', type: 'task', status: 'unassigned' });
    const claimed = await service.claim(created.id, 'instance-1');

    await service.close(created.id, { closedBy: 'human-command', reason: '取消任务' });

    const closed = await service.getById(created.id);
    expect(closed?.status).toBe('closed');
    expect(closed?.execution?.current).toMatchObject({
      id: claimed.execution?.current?.id,
      status: 'cancelled',
    });
    expect(closed?.execution?.assignments).toHaveLength(1);
  });

  it('评审证据汇总到 WU 当前 Assignment', async () => {
    const created = await service.create({ scope: '证据聚合', type: 'task', status: 'unassigned' });
    await service.claim(created.id, 'instance-1');
    await service.transitionStatus(created.id, 'in_review');

    await service.reviewPassed(created.id, {
      kind: 'human-confirm', by: 'operator-1', summary: '验收通过',
    });

    const completed = await service.getById(created.id);
    expect(completed?.execution?.current?.evidenceCount).toBe(1);
    expect(completed?.execution?.totals.evidenceCount).toBe(1);
  });

  it('最终超时释放会终结 running，人工恢复创建链接轮次', async () => {
    const created = await service.create({ scope: '最终超时', type: 'task', status: 'unassigned' });
    const claimed = await service.claim(created.id, 'instance-1');
    await service.updateMetadata(created.id, { timeoutReleaseCount: MAX_TIMEOUT_RELEASES - 1 });

    await scanTimedOutWorkUnits(store, new Date(Date.now() + 10 * 60 * 1000));
    const blocked = await service.getById(created.id);
    expect(blocked?.status).toBe('blocked');
    expect(blocked?.execution?.current?.status).toBe('cancelled');

    await resumeWaitingWorkUnit(created.id, '人工恢复', store);
    const resumed = await service.getById(created.id);
    expect(resumed?.execution?.current).toMatchObject({
      attempt: 2,
      status: 'queued',
      previousAssignmentId: claimed.execution?.current?.id,
    });
  });
});
